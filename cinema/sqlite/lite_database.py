"""Build and verify the Cinema Lite distribution database."""
import json
from pathlib import Path
import re
import sys

from database import asset, checksum, compact, compressed_copy, connect, digest, write_meta, metadata

FORMAT = 'vega-cinema-lite-v1'
DETAIL_PATH = 'cinema/data/items/{workId}.json'
INSERT = {
    'work': 'INSERT INTO works VALUES (?,?,?,?,?,?)',
    'artwork': 'INSERT INTO artwork VALUES (?,?,?,?,?,?,?,?,?,?)',
    'rule': 'INSERT INTO image_rules VALUES (?,?,?,?)',
}


def verify(db):
    meta = metadata(db)
    if (meta['format'] != FORMAT or db.execute('PRAGMA user_version').fetchone() != (1,)
            or db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]
            or db.execute('PRAGMA foreign_key_check').fetchall()):
        raise ValueError('Invalid Cinema Lite database')
    counts = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
              for table in ('works', 'artwork', 'image_rules')}
    if counts != meta['counts'] or db.execute('SELECT count(*) FROM search').fetchone()[0] != meta['activeCount']:
        raise ValueError('Invalid Cinema Lite counts')
    db.execute("INSERT INTO search(search) VALUES('integrity-check')")
    return meta


def build(rows, out, source_commit, exporter_commit):
    if not all(re.fullmatch(r'[a-f0-9]{40}', sha) for sha in (source_commit, exporter_commit)):
        raise ValueError('Expected full Git commit IDs')
    out = Path(out)
    out.mkdir()
    file = out / 'cinema.sqlite'
    with connect(file) as db:
        db.executescript("""
          PRAGMA user_version=1;
          CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE works(
            id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1)),
            replaced_by TEXT REFERENCES works(id) DEFERRABLE INITIALLY DEFERRED,
            info TEXT NOT NULL CHECK(json_valid(info)), detail_sha256 TEXT NOT NULL,
            detail_bytes INTEGER NOT NULL CHECK(detail_bytes>0)
          );
          CREATE TABLE artwork(
            id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
            field TEXT NOT NULL CHECK(field IN ('poster','background','logo')),
            source TEXT NOT NULL, language TEXT, forced INTEGER NOT NULL,
            rank INTEGER NOT NULL, width INTEGER, height INTEGER, url TEXT NOT NULL
          );
          CREATE INDEX artwork_work_field ON artwork(work_id,field);
          CREATE TABLE image_rules(scope TEXT NOT NULL,field TEXT NOT NULL,source TEXT NOT NULL,language TEXT);
          CREATE INDEX works_type_year ON works(json_extract(info,'$.type'),json_extract(info,'$.year')) WHERE active=1;
          CREATE INDEX works_added ON works(json_extract(info,'$.created_at') DESC,id) WHERE active=1;
          CREATE INDEX works_views ON works(CAST(coalesce(json_extract(info,'$.views'),json_extract(info,'$.views_count'),0) AS REAL) DESC,id) WHERE active=1;
          CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,title,original_title,synopsis,tokenize='unicode61 remove_diacritics 2');
        """)
        source = None
        db.execute('BEGIN')
        with Path(rows).open(encoding='utf-8') as stream:
            for line in stream:
                kind, *values = json.loads(line)
                if source is not None:
                    raise ValueError('Unexpected data after source metadata')
                if kind == 'source':
                    source = values
                    continue
                if kind == 'work':
                    values[3] = compact(values[3])
                db.execute(INSERT[kind], values)
        expected, active, origins = source
        db.execute("""INSERT INTO search SELECT id,
          coalesce(json_extract(info,'$.title'),json_extract(info,'$.name'),''),
          coalesce(json_extract(info,'$.original_name'),json_extract(info,'$.original_title'),''),
          coalesce(json_extract(info,'$.synopsis'),'') FROM works WHERE active=1""")
        counts = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                  for table in ('works', 'artwork', 'image_rules')}
        if counts['works'] != expected or db.execute('SELECT count(*) FROM search').fetchone()[0] != active:
            raise ValueError('Source/export count mismatch')
        meta = {
            'format': FORMAT, 'catalogId': 'cinema', 'schemaVersion': 1,
            'sourceCommit': source_commit, 'exporterCommit': exporter_commit,
            'detailPath': DETAIL_PATH, 'origins': origins, 'activeCount': active,
            'counts': counts, 'revision': digest(compact([FORMAT, source_commit, exporter_commit, checksum(rows)])),
        }
        write_meta(db, meta)
        db.commit()
        verify(db)
        db.commit()
    zipped = out / 'cinema.sqlite.gz'
    compressed_copy(file, zipped)
    manifest = {**meta, 'snapshot': {**asset(zipped), 'uncompressedBytes': file.stat().st_size,
                                   'uncompressedSha256': checksum(file)}}
    (out / 'manifest.json').write_text(compact(manifest) + '\n', encoding='utf-8')
    print(compact(manifest), flush=True)


if __name__ == '__main__':
    if sys.argv[1] == 'verify':
        with connect(sys.argv[2]) as connection:
            print(compact(verify(connection)))
    else:
        build(*sys.argv[1:])
