"""Exercise publication/recovery with GitHub and Git replaced by an in-memory remote."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sqlite'))
import publish
from database import asset


class Publication(unittest.TestCase):
    def test_delta_history_retains_a_bounded_contiguous_suffix(self):
        def edge(a,b):
            return {'fromRevision':a*64,'toRevision':b*64,'name':'delta.ndjson.gz','url':'https://github.com/test/database/releases/download/cinema-sqlite-v1-'+'e'*64+'/delta.ndjson.gz'}
        first,second,latest=edge('a','b'),edge('b','c'),edge('c','d')
        self.assertEqual(publish.delta_history({'deltas':[first,second]},latest,'test/database'),[first,second,latest])
        self.assertEqual(publish.delta_history({'deltas':[first,second]},latest,'test/database',limit=2),[second,latest])
        broken=edge('f','a')
        self.assertEqual(publish.delta_history({'deltas':[broken,second]},latest,'test/database'),[second,latest])
        self.assertEqual(publish.delta_history({'deltas':[first,second]},None,'test/database'),[])

    def test_interrupted_activation_resumes_without_overwriting_public_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            remote=Path(temp)
            state={'draft':None,'tag':None,'activated':False,'failPush':True,'uploads':0,'complete':True}

            def command(*args,cwd=None):
                args=list(args)
                if args[:3]==['git','rev-parse','HEAD']: return 'a'*40
                if args[:3]==['git','rev-parse','FETCH_HEAD']: return 'b'*40
                if args[:2]==['git','show']: return json.dumps({'complete':state['complete'],'pendingCount':0})
                if args[:2]==['git','init']:
                    Path(args[-1]).mkdir(parents=True);return ''
                if args[:2]==['git','push']:
                    if state['failPush']: raise subprocess.CalledProcessError(1,args)
                    shutil.copyfile(Path(cwd)/'manifest.json',remote/'active-manifest.json');state['activated']=True;return ''
                if args[:2]==['gh','api']:
                    return '' if state['draft'] is None else str(state['draft']).lower()
                if args[:3]==['gh','release','create']:
                    state['tag']=args[3];state['draft']=True;return ''
                if args[:3]==['gh','release','upload']:
                    self.assertTrue(state['draft'],'Published releases must be immutable')
                    file=Path(args[4]);shutil.copyfile(file,remote/file.name);state['uploads']+=1;return ''
                if args[:3]==['gh','release','download']:
                    name=args[args.index('--pattern')+1];folder=Path(args[args.index('--dir')+1]);folder.mkdir(parents=True,exist_ok=True)
                    shutil.copyfile(remote/name,folder/name);return ''
                if args[:3]==['gh','release','edit']:
                    self.assertFalse(state['activated']);state['draft']=False;return ''
                return ''

            def run(args,**kwargs):
                if args[0]=='node':
                    (Path(args[2]).parents[1]).mkdir(parents=True,exist_ok=True)
                    out=Path(args[3]);out.mkdir(parents=True)
                    (out/'cinema.sqlite.gz').write_bytes(b'verified fixture snapshot')
                    manifest={'catalogId':'cinema','schemaVersion':1,'revision':'c'*64,'sourceCommit':'b'*40,'exporterCommit':'a'*40,'validationOnly':False,'snapshot':asset(out/'cinema.sqlite.gz'),'deltas':[]}
                    (out/'manifest.json').write_text(json.dumps(manifest))
                return subprocess.CompletedProcess(args,0)

            with patch.dict(os.environ,{'GH_REPO':'test/database'}),patch.object(publish,'command',side_effect=command),patch.object(publish,'branch_exists',return_value=False),patch.object(publish.subprocess,'run',side_effect=run),patch.object(publish.tarfile,'open',return_value=MagicMock()),patch.object(publish.time,'sleep'):
                with self.assertRaises(subprocess.CalledProcessError):publish.main()
                self.assertFalse(state['activated']);self.assertFalse(state['draft'])
                uploads=state['uploads'];state['failPush']=False
                publish.main()
                self.assertTrue(state['activated']);self.assertEqual(state['uploads'],uploads)
                self.assertEqual(json.loads((remote/'active-manifest.json').read_text())['revision'],'c'*64)
                state['complete']=False;state['activated']=False;publish.main()
                self.assertFalse(state['activated']);self.assertEqual(state['uploads'],uploads)

    def test_bad_download_cannot_activate(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp);(folder/'cinema.sqlite.gz').write_bytes(b'corrupt')
            with patch.object(publish,'command',return_value=''):
                with self.assertRaisesRegex(ValueError,'checksum'):
                    publish.download_asset('test/database','tag',{'name':'cinema.sqlite.gz','sha256':'0'*64,'bytes':7},folder)


if __name__=='__main__':unittest.main()
