"""SQLite publication and logical deltas. Python stdlib only; no scraping/network."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

SCHEMA = 1
KINDS = ('work', 'season', 'episode', 'source', 'source_season', 'source_episode',
         'artwork', 'artwork_assignment', 'artwork_inventory', 'external_id', 'alias', 'configuration')
VIEWS = {'artwork_inventory':'artwork_inventories', 'alias':'aliases'}


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def checksum(file):
    h = hashlib.sha256()
    with Path(file).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect(file):
    db = sqlite3.connect(file, factory=Connection)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA cache_size=-131072')
    db.execute('PRAGMA temp_store=FILE')
    return db


def initialize(db):
    db.executescript('''
      PRAGMA user_version=1;
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE records(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, work_id TEXT REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
        parent_id TEXT REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
        artwork_id TEXT REFERENCES records(id) DEFERRABLE INITIALLY DEFERRED,
        payload TEXT NOT NULL CHECK(json_valid(payload)), hash TEXT NOT NULL
      );
      CREATE INDEX records_work_kind ON records(work_id,kind);
      CREATE INDEX records_kind ON records(kind);
      CREATE INDEX records_parent ON records(parent_id);
      CREATE INDEX records_artwork ON records(artwork_id);
      CREATE INDEX home_type_year ON records(json_extract(payload,'$.info.type'),json_extract(payload,'$.info.year'))
        WHERE kind='work' AND json_extract(payload,'$.active')=1;
      CREATE INDEX artwork_selection ON records(work_id, json_extract(payload,'$.scope'),
        json_extract(payload,'$.season'), json_extract(payload,'$.episode'), json_extract(payload,'$.field'))
        WHERE kind='artwork_assignment' AND json_extract(payload,'$.eligible')=1;
      CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,original_title,synopsis,tokenize='unicode61 remove_diacritics 2');
    ''')
    for kind in KINDS:
        db.execute(f"CREATE VIEW {VIEWS.get(kind,kind+'s')} AS SELECT * FROM records WHERE kind='{kind}'")


def row(value):
    if value['kind'] not in KINDS:
        raise ValueError('Unknown record kind')
    fields = [value['id'], value['kind'], value['workId'], value['parentId'], value['artworkId'], compact(value['payload'])]
    return fields + [digest(compact(fields))]


def rebuild_search(db):
    db.execute('DELETE FROM search')
    db.execute('''INSERT INTO search SELECT id,
      coalesce(json_extract(payload,'$.info.title'),json_extract(payload,'$.info.name'),''),
      coalesce(json_extract(payload,'$.info.original_name'),json_extract(payload,'$.info.original_title'),''),
      coalesce(json_extract(payload,'$.info.synopsis'),'')
      FROM records WHERE kind='work' AND json_extract(payload,'$.active')=1''')


def logical_hash(db):
    h = hashlib.sha256(('cinema-schema-' + str(SCHEMA)).encode())
    # Scanning the TEXT primary-key index would perform millions of random
    # lookups into large JSON rows. A sequential scan plus external sort is bounded
    # and preserves exactly the same BINARY ID ordering.
    for (stored_hash,) in db.execute('SELECT hash FROM records NOT INDEXED ORDER BY id'):
        h.update(stored_hash.encode('ascii'))
    return h.hexdigest()


def metadata(db):
    return {k: json.loads(v) for k, v in db.execute('SELECT key,value FROM metadata')}


def verify(db, thorough=True):
    if db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA:
        raise ValueError('Unsupported schema')
    if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('Invalid SQLite integrity/relations')
    if thorough:
        for values in db.execute('SELECT * FROM records'):
            if digest(compact(values[:-1])) != values[-1]:
                raise ValueError('Invalid record hash')
    meta = metadata(db)
    if meta.get('catalogId')!='cinema' or meta.get('schemaVersion')!=SCHEMA:
        raise ValueError('Invalid catalog metadata')
    if meta['revision'] != logical_hash(db):
        raise ValueError('Invalid logical revision')
    count = db.execute("SELECT count(*) FROM records WHERE kind='work'").fetchone()[0]
    active = db.execute('SELECT count(*) FROM search').fetchone()[0]
    if dict(db.execute('SELECT kind,count(*) FROM records GROUP BY kind'))!=meta['counts'] or count != meta['counts']['work'] or active != meta['activeCount']:
        raise ValueError('Invalid work/search counts')
    if db.execute("SELECT a.id FROM records a LEFT JOIN records w ON w.id=json_extract(a.payload,'$.target') AND w.kind='work' WHERE a.kind='alias' AND (w.id IS NULL OR w.id=a.work_id) LIMIT 1").fetchone():
        raise ValueError('Invalid alias target')
    db.execute("INSERT INTO search(search) VALUES('integrity-check')")
    return meta


def write_meta(db, meta):
    db.execute('DELETE FROM metadata')
    db.executemany('INSERT INTO metadata VALUES(?,?)', [(k, compact(v)) for k, v in meta.items()])


def compressed_copy(source, target):
    with open(source, 'rb') as src, open(target, 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as out:
            shutil.copyfileobj(src, out)


def asset(file):
    p = Path(file)
    return {'name': p.name, 'bytes': p.stat().st_size, 'sha256': checksum(p)}


def make_delta(previous, current, target):
    if not Path(previous).is_file():
        raise ValueError('Previous database does not exist')
    with connect(previous) as old:
        old_meta = verify(old)
    current_meta = metadata(current)
    if old_meta['catalogId'] != 'cinema' or old_meta.get('validationOnly'):
        raise ValueError('Previous database is not a published Cinema catalog')
    if old_meta['revision'] == current_meta['revision']:
        return None
    current.execute('ATTACH DATABASE ? AS previous', (str(Path(previous).resolve()),))
    with open(target, 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
        def emit(value):
            zipped.write((compact(value) + '\n').encode('utf-8'))
        emit({'format': 'vega-cinema-delta-v1', 'baseRevision': old_meta['revision'], 'target': current_meta})
        for values in current.execute('SELECT n.* FROM records n LEFT JOIN previous.records p ON p.id=n.id WHERE p.id IS NULL OR n.hash!=p.hash ORDER BY n.id'):
            emit({'upsert': values})
        for (key,) in current.execute('SELECT p.id FROM previous.records p LEFT JOIN records n ON n.id=p.id WHERE n.id IS NULL ORDER BY p.id'):
            emit({'delete': key})
    current.execute('DETACH DATABASE previous')
    return {**asset(target), 'fromRevision': old_meta['revision'], 'toRevision': current_meta['revision']}


def apply_delta(previous, delta, output, *, consume_base=False):
    # Backup API handles WAL safely. Never modify the installed/base database.
    output = Path(output)
    if not Path(previous).is_file():
        raise ValueError('Previous database does not exist')
    if output.exists():
        raise ValueError('Delta output must be a new file')
    temp = output.with_suffix(output.suffix + '.staging')
    if temp.exists():
        raise ValueError('Staging file already exists')
    try:
        if consume_base:
            # Publisher-only optimization: previous is a disposable download in /tmp.
            os.replace(previous,temp)
            src,db=None,connect(temp)
        else:
            src,db=connect(previous),connect(temp)
        try:
            if src is not None:
                src.backup(db)
            base = verify(db)
            db.commit()
            with gzip.open(delta, 'rt', encoding='utf-8') as f:
                header = json.loads(next(f))
                if header['format'] != 'vega-cinema-delta-v1' or header['baseRevision'] != base['revision'] or header['target']['schemaVersion'] != SCHEMA or header['target']['catalogId']!='cinema' or header['target'].get('validationOnly'):
                    raise ValueError('Delta base/schema mismatch')
                db.execute('BEGIN')
                db.execute('PRAGMA defer_foreign_keys=ON')
                for line in f:
                    change = json.loads(line)
                    if set(change) == {'upsert'}:
                        values = change['upsert']
                        if len(values) != 7 or values[1] not in KINDS or digest(compact(values[:-1])) != values[-1]:
                            raise ValueError('Invalid delta row')
                        db.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,work_id=excluded.work_id,parent_id=excluded.parent_id,artwork_id=excluded.artwork_id,payload=excluded.payload,hash=excluded.hash', values)
                    elif set(change) == {'delete'}:
                        db.execute('DELETE FROM records WHERE id=?', (change['delete'],))
                    else:
                        raise ValueError('Invalid delta operation')
                rebuild_search(db)
                write_meta(db, header['target'])
                verify(db)
                db.commit()
        finally:
            db.close()
            if src is not None:
                src.close()
        os.replace(temp, output)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def build(out, previous=None):
    out = Path(out)
    info = json.loads((out / 'input.json').read_text(encoding='utf-8'))
    file = out / 'cinema.sqlite'
    if file.exists():
        raise ValueError('Use a fresh output directory')
    db = connect(file)
    try:
        initialize(db)
        db.execute('BEGIN')
        with (out / 'rows.ndjson').open(encoding='utf-8') as lines:
            for number, line in enumerate(lines,1):
                values = row(json.loads(line))
                inserted=db.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',values).rowcount
                if not inserted and db.execute('SELECT hash FROM records WHERE id=?',(values[0],)).fetchone()[0]!=values[-1]:
                    raise ValueError('Conflicting duplicate record')
                if number%100000==0:
                    print('CINEMA_SQLITE_IMPORT rows='+str(number),flush=True)
        defaults = json.loads(Path(__file__).with_name('preferences.json').read_text(encoding='utf-8'))
        db.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)', row({'id':'configuration:cinema','kind':'configuration','workId':None,'parentId':None,'artworkId':None,'payload':defaults}))
        db.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)', row({'id':'configuration:origins','kind':'configuration','workId':None,'parentId':None,'artworkId':None,'payload':info.get('origins',{})}))
        rebuild_search(db)
        counts = dict(db.execute('SELECT kind,count(*) FROM records GROUP BY kind'))
        active = db.execute('SELECT count(*) FROM search').fetchone()[0]
        if counts.get('work', 0) != info['expectedCount'] or active != info['expectedActiveCount']:
            raise ValueError('Source/export count mismatch')
        meta = {'catalogId':'cinema','schemaVersion':SCHEMA,'minimumReaderVersion':1,'revision':logical_hash(db),
                'sourceCommit':info['sourceCommit'],'exporterCommit':info['exporterCommit'],'origins':info.get('origins',{}),
                'validationOnly':not info['complete'],'counts':counts,'activeCount':active}
        write_meta(db, meta)
        db.commit()
        (out / 'rows.ndjson').unlink()
        print('CINEMA_SQLITE_VERIFY',flush=True)
        verify(db)
        db.commit()
        delta = make_delta(previous, db, out / 'delta.ndjson.gz') if previous else None
    finally:
        db.close()
    if delta:
        with tempfile.TemporaryDirectory(prefix='cinema-replay-') as temp:
            replay = Path(temp) / 'replay.sqlite'
            apply_delta(previous, out / delta['name'], replay,consume_base=os.environ.get('CINEMA_SQLITE_DISPOSABLE_BASE')=='1')
            with connect(replay) as check:
                if verify(check)['revision'] != meta['revision']:
                    raise ValueError('Delta replay differs from snapshot')
    compressed_copy(file, out / 'cinema.sqlite.gz')
    manifest = {**meta,'snapshot':{**asset(out/'cinema.sqlite.gz'),'uncompressedBytes':file.stat().st_size,'uncompressedSha256':checksum(file)},'deltas':[delta] if delta else []}
    (out/'manifest.json').write_text(compact(manifest)+'\n',encoding='utf-8')
    print(compact({'revision':meta['revision'],'counts':counts,'bytes':file.stat().st_size,'downloadBytes':manifest['snapshot']['bytes'],'validationOnly':meta['validationOnly']}))


if __name__ == '__main__':
    if sys.argv[1] == 'build':
        build(*sys.argv[2:])
    elif sys.argv[1] == 'apply':
        apply_delta(*sys.argv[2:])
    elif sys.argv[1] == 'verify':
        with connect(sys.argv[2]) as connection:
            print(compact(verify(connection)))
    else:
        raise ValueError('Unknown command')
