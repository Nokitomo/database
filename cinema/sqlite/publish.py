"""GitHub release orchestrator. Only the final manifest push activates a revision."""
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from database import checksum, verify, connect, digest, compact


def command(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def retry(fn):
    for attempt in range(3):
        try:
            return fn()
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def branch_exists(repo, branch):
    result = subprocess.run(['git','ls-remote','--exit-code','--heads',repo,'refs/heads/'+branch], capture_output=True, text=True)
    if result.returncode not in (0, 2):
        raise RuntimeError(result.stderr)
    return result.returncode == 0


def download_asset(repo, tag, spec, out):
    name = spec['name']
    if name not in ('cinema.sqlite.gz', 'delta.ndjson.gz', 'manifest.json'):
        raise ValueError('Unexpected release asset name')
    out.mkdir(parents=True, exist_ok=True)
    retry(lambda: command('gh','release','download',tag,'--repo',repo,'--pattern',name,'--dir',str(out),'--clobber'))
    file = out/name
    if checksum(file) != spec['sha256'] or file.stat().st_size != spec['bytes']:
        raise ValueError('Release asset checksum/size mismatch')
    return file


def delta_history(prior, latest, repo, limit=100):
    """Retain only a contiguous, same-repository suffix ending at the base."""
    if not latest:
        return []
    current=latest['fromRevision'];suffix=[]
    for edge in reversed((prior or {}).get('deltas',[])):
        if len(suffix)>=limit-1:
            break
        if edge.get('toRevision')!=current or not re.fullmatch(r'[a-f0-9]{64}',edge.get('fromRevision','')) or edge.get('name')!='delta.ndjson.gz' or not re.fullmatch(re.escape(f'https://github.com/{repo}/releases/download/cinema-sqlite-v1-')+r'[a-f0-9]{64}/delta\.ndjson\.gz',edge.get('url','')):
            break
        suffix.append(edge);current=edge['fromRevision']
    return list(reversed(suffix))+[latest]


def complete_source(manifest):
    return manifest['complete'] is True and manifest['pendingCount'] == 0


def main(*, lite=False):
    publication_branch = 'cinema-sqlite-lite' if lite else 'cinema-sqlite'
    tag_prefix = publication_branch + '-v1-'
    title = 'Cinema SQLite Lite' if lite else 'Cinema SQLite'
    repo = os.environ['GH_REPO']
    if not re.fullmatch(r'[\w.-]+/[\w.-]+',repo):
        raise ValueError('Invalid repository')
    if os.environ.get('CINEMA_SQLITE_VALIDATION_ONLY'):
        raise ValueError('Validation mode cannot publish')
    code = Path(__file__).resolve().parents[2]
    if command('git','status','--porcelain',cwd=code):
        raise ValueError('Publication requires a clean, committed exporter checkout')
    exporter = command('git','rev-parse','HEAD',cwd=code)
    remote = 'https://github.com/'+repo+'.git'
    command('gh','auth','setup-git')
    with tempfile.TemporaryDirectory(prefix='cinema-sqlite-') as folder:
        root = Path(folder)
        command('git','fetch','--depth=1','origin','cinema-data',cwd=code)
        source = command('git','rev-parse','FETCH_HEAD',cwd=code)
        raw_manifest = json.loads(command('git','show',source+':cinema/data/manifest.json',cwd=code))
        if lite and not complete_source(raw_manifest) and not branch_exists(remote, publication_branch):
            command('git','fetch','--depth=1','origin','cinema-sqlite',cwd=code)
            full = json.loads(command('git','show','FETCH_HEAD:manifest.json',cwd=code))
            source = full['sourceCommit']
            if full.get('validationOnly') is not False or not re.fullmatch(r'[a-f0-9]{40}',source):
                raise ValueError('Invalid full Cinema publication')
            command('git','fetch','--depth=1','origin',source,cwd=code)
            raw_manifest = json.loads(command('git','show',source+':cinema/data/manifest.json',cwd=code))
            print('CINEMA_SQLITE_LITE_BOOTSTRAP '+source, flush=True)
        if not complete_source(raw_manifest):
            print('CINEMA_SQLITE_SKIP incomplete source; previous release remains active')
            return
        branch = root/'publication'
        command('git','init','-b',publication_branch,str(branch))
        command('git','remote','add','origin',remote,cwd=branch)
        if branch_exists(remote,publication_branch):
            command('git','fetch','--depth=1','origin',publication_branch,cwd=branch)
            command('git','checkout','-B',publication_branch,'FETCH_HEAD',cwd=branch)
        prior = json.loads((branch/'manifest.json').read_text()) if (branch/'manifest.json').exists() else None
        if prior and prior['sourceCommit']==source and prior['exporterCommit']==exporter:
            print('CINEMA_SQLITE_SKIP identical source and exporter')
            return
        archive = root/'source.tar'
        with archive.open('wb') as output:
            subprocess.run(['git','archive',source,'cinema/data'],cwd=code,stdout=output,check=True)
        with tarfile.open(archive) as tar:
            tar.extractall(root/'source',filter='data')
        archive.unlink()
        previous = None
        if not lite and prior and prior['schemaVersion']==1:
            if prior.get('validationOnly') or not re.fullmatch(r'cinema-sqlite-v1-[a-f0-9]{64}',prior['releaseTag']):
                raise ValueError('Invalid previous publication')
            zipped = download_asset(repo,prior['releaseTag'],prior['snapshot'],root/'previous')
            previous = root/'previous/cinema.sqlite'
            with gzip.open(zipped,'rb') as src, previous.open('wb') as dst:
                shutil.copyfileobj(src,dst)
            if checksum(previous)!=prior['snapshot']['uncompressedSha256'] or previous.stat().st_size!=prior['snapshot']['uncompressedBytes']:
                raise ValueError('Previous SQLite checksum mismatch')
            zipped.unlink()
            with connect(previous) as db:
                if verify(db)['revision']!=prior['revision']:
                    raise ValueError('Previous revision mismatch')
        out = root/'output'
        if lite:
            rows = root/'lite.ndjson'
            subprocess.run(['node',str(code/'cinema/sqlite/export-lite.js'),str(root/'source/cinema/data'),str(rows)],cwd=code,check=True)
            shutil.rmtree(root/'source')
            subprocess.run([sys.executable,'-B',str(code/'cinema/sqlite/lite_database.py'),str(rows),str(out),source,exporter],cwd=code,check=True)
        else:
            subprocess.run(['node',str(code/'cinema/sqlite/export.js'),str(root/'source/cinema/data'),str(out),source,exporter],cwd=code,check=True,env={**os.environ,'CINEMA_SQLITE_ROWS_ONLY':'1'})
            shutil.rmtree(root/'source')
            subprocess.run([sys.executable,'-B',str(code/'cinema/sqlite/database.py'),'build',str(out)]+([str(previous)] if previous else []),cwd=code,check=True,env={**os.environ,'CINEMA_SQLITE_DISPOSABLE_BASE':'1'})
        manifest = json.loads((out/'manifest.json').read_text())
        if not lite and manifest['validationOnly']:
            raise ValueError('Refusing validation artifact')
        if prior and prior['revision']==manifest['revision']:
            print('CINEMA_SQLITE_SKIP no logical changes')
            return
        specs = [manifest['snapshot']]
        if lite:
            manifest['updatePolicy'] = {'snapshot':'full'}
        else:
            specs.extend(manifest['deltas'])
            latest = manifest['deltas'][0] if manifest['deltas'] else None
            manifest['deltas'] = delta_history(prior,latest,repo)
        tag = tag_prefix+digest(compact(manifest))
        if not lite:
            manifest['updatePolicy'] = {'delta':'contiguous-chain','maxDeltas':100,'fallback':'full-snapshot'}
        manifest['releaseTag']=tag
        for spec in specs:
            if spec['bytes'] >= 2*1024**3:
                raise ValueError('Release asset exceeds GitHub size limit')
            spec['url']=f'https://github.com/{repo}/releases/download/{tag}/{spec["name"]}'
        # Old edges keep their immutable original URLs; upload only this release's assets.
        manifest_text=json.dumps(manifest,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n'
        (out/'manifest.json').write_text(manifest_text,encoding='utf-8')
        # Read the releases inventory to distinguish a genuine missing tag from API errors.
        result=command('gh','api','--paginate',f'repos/{repo}/releases','--jq',f'.[] | select(.tag_name == "{tag}") | .draft')
        if not result:
            retry(lambda:command('gh','release','create',tag,'--repo',repo,'--target',exporter,'--draft','--title',('Cinema SQLite Lite ' if lite else 'Cinema ')+manifest['revision'][:12],'--notes',f'Verified {title} snapshot. Activation is controlled by the {publication_branch} branch manifest.'))
            result='true'
        if result=='true':
            for name in [*[spec['name'] for spec in specs],'manifest.json']:
                retry(lambda name=name:command('gh','release','upload',tag,str(out/name),'--repo',repo,'--clobber'))
        # Re-read uploaded assets before activation, including after interrupted runs.
        for spec in specs:
            download_asset(repo,tag,spec,root/'verify-release')
        published_manifest_spec={'name':'manifest.json','bytes':(out/'manifest.json').stat().st_size,'sha256':checksum(out/'manifest.json')}
        download_asset(repo,tag,published_manifest_spec,root/'verify-release')
        if result=='true':
            retry(lambda:command('gh','release','edit',tag,'--repo',repo,'--draft=false','--latest=false'))
        (branch/'manifest.json').write_text(manifest_text,encoding='utf-8')
        assets = 'SQLite' if lite else 'SQLite and deltas'
        (branch/'README.md').write_text(f'# {title}\n\nGenerated publication pointer. {assets} are immutable GitHub Release assets.\n',encoding='utf-8')
        command('git','config','user.name','github-actions[bot]',cwd=branch)
        command('git','config','user.email','41898282+github-actions[bot]@users.noreply.github.com',cwd=branch)
        command('git','add','manifest.json','README.md',cwd=branch)
        command('git','commit','-m','Publish '+title+' '+manifest['revision'][:12],cwd=branch)
        retry(lambda:command('git','push','origin','HEAD:refs/heads/'+publication_branch,cwd=branch))
        print('CINEMA_SQLITE_PUBLISHED '+manifest['revision'])


if __name__=='__main__':
    if sys.argv[1:] not in ([], ['--lite']):
        raise SystemExit('Usage: publish.py [--lite]')
    main(lite=sys.argv[1:] == ['--lite'])
