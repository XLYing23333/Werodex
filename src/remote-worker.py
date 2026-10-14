#!/usr/bin/env python3
"""Werodex-owned worker. stdlib only; never interprets file/log content as commands."""
import ctypes, errno, fcntl, asyncio, heapq, shutil, selectors, base64, collections, hashlib, json, os, pathlib, re, signal, socket, sqlite3, stat, struct, subprocess, sys, time, uuid
MAX_FRAME=65536
MAX_MESSAGE=20*1024*1024
CHUNK=32768
UUID=re.compile(r'^[a-f0-9-]{36}$')

def kill_group(pid,kind):
    try:os.killpg(pid,kind)
    except ProcessLookupError:pass

def dump(value): return json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
def atomic(file,value):
    temporary=str(file)+'.'+uuid.uuid4().hex+'.tmp'
    with open(temporary,'xb') as out: os.chmod(temporary,0o600); out.write(dump(value))
    os.replace(temporary,file)
def load(file,default=None):
    try:
        if os.path.islink(file) or os.stat(file).st_size>1024*1024: raise ValueError('unsafe metadata')
        with open(file,'rb') as source: return json.load(source)
    except (OSError,ValueError): return default

def private(directory):
    directory=pathlib.Path(directory)
    if directory.is_symlink(): raise ValueError('state symlink')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    info=directory.stat()
    if not directory.is_dir() or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700: raise ValueError('state permissions')
    return directory

def safe(root,name,missing=False):
    root=os.path.abspath(root)
    if os.path.realpath(root)!=root: raise ValueError('WDX_PATH: symlink root')
    if not isinstance(name,str) or not name or '\x00' in name: raise ValueError('WDX_PATH: invalid path')
    candidate=os.path.abspath(os.path.join(root,name))
    if candidate!=root and not candidate.startswith(root+os.sep): raise ValueError('WDX_PATH: outside workspace')
    if os.path.realpath(candidate)!=candidate: raise ValueError('WDX_PATH: symlink path')
    if not missing and not os.path.exists(candidate): raise ValueError('WDX_PATH: missing file')
    return pathlib.Path(candidate)

def secret(name): return any(p in ('.git','.env','.ssh','.aws','.gnupg','.npmrc','.pypirc','.netrc','id_rsa','id_ecdsa','id_ed25519') or p.startswith('.env.') for p in pathlib.Path(name).parts)
def eligible(name,size,policy):
    parts=pathlib.PurePosixPath(name).parts
    if any(p in policy['protectedNames'] or p in policy['fixedExclude'] or p.startswith('.env.') for p in parts): return False
    if any(name==p or name.startswith(p+'/') for p in policy['exclude']): return False
    return size<=policy['maxBytes'] or any(name.lower().endswith(ext) for ext in policy['sourceExtensions'])

def bounded(argv,cwd=None,input=None,maximum=16*1024*1024,timeout=30):
    process=subprocess.Popen(argv,cwd=cwd,stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    output={process.stdout:bytearray(),process.stderr:bytearray()};read=selectors.DefaultSelector()
    for pipe in output:os.set_blocking(pipe.fileno(),False);read.register(pipe,selectors.EVENT_READ)
    pending=memoryview(input or b'');position=0
    if input is not None:os.set_blocking(process.stdin.fileno(),False);read.register(process.stdin,selectors.EVENT_WRITE)
    try:
        deadline=time.monotonic()+timeout
        while read.get_map():
            if time.monotonic()>deadline:raise ValueError('WDX_TIMEOUT: program deadline exceeded')
            for key,events in read.select(.1):
                if key.fileobj is process.stdin:
                    if position<len(pending):position+=os.write(process.stdin.fileno(),pending[position:position+32768])
                    if position>=len(pending):read.unregister(process.stdin);process.stdin.close()
                else:
                    data=os.read(key.fileobj.fileno(),32768)
                    if not data:read.unregister(key.fileobj);key.fileobj.close();continue
                    if len(output[key.fileobj])+len(data)>maximum:raise ValueError('WDX_OUTPUT_LIMIT: select a smaller Source scope')
                    output[key.fileobj].extend(data)
        return subprocess.CompletedProcess(argv,process.wait(timeout=max(.1,deadline-time.monotonic())),bytes(output[process.stdout]),bytes(output[process.stderr]))
    finally:
        read.close()
        if process.poll() is None:kill_group(process.pid,signal.SIGKILL);process.wait()
        for pipe in (process.stdin,process.stdout,process.stderr):
            if pipe and not pipe.closed:pipe.close()

def git(root,args,input=None):
    result=bounded(['git',*args],root,input)
    if result.returncode>1: raise ValueError('WDX_GIT: '+result.stderr.decode(errors='replace'))
    return result

def boundary(root):
    top=git(root,['rev-parse','--show-toplevel'])
    if top.returncode: raise ValueError('WDX_GIT: project repository unavailable')
    if os.path.realpath(top.stdout.decode().strip())!=os.path.realpath(root): raise ValueError('WDX_GIT_PARENT: project belongs to parent Git repository')

def scan(root,policy,cache_root,paths=None,full=False):
    boundary(root)
    if paths is None:
        names=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).stdout.split(b'\0')
        names=list(dict.fromkeys(os.fsdecode(x) for x in names if x))
    else: names=paths
    items=[];large=[]
    for name in names:
        try:
            file=safe(root,name);info=file.stat()
            if not stat.S_ISREG(info.st_mode): continue
            if not eligible(name,info.st_size,policy):
                if not any(p in policy['protectedNames'] or p in policy['fixedExclude'] for p in pathlib.PurePosixPath(name).parts) and info.st_size>policy['maxBytes'] and not any(name==p or name.startswith(p+'/') for p in policy['exclude']): large.append({'path':name,'size':info.st_size})
                continue
            items.append((name,file,info))
        except (OSError,ValueError): continue
    ignored=set()
    if items:
        result=git(root,['check-ignore','--no-index','--stdin','-z'],b'\0'.join(os.fsencode(x[0]) for x in items)+b'\0')
        ignored={os.fsdecode(x) for x in result.stdout.split(b'\0') if x}
    database=sqlite3.connect(str(private(cache_root)/'index.sqlite'),timeout=5)
    database.execute('pragma journal_mode=WAL');database.execute('create table if not exists files(root text,path text,token text,hash text,primary key(root,path))')
    files=[];metadata_bytes=0;deadline=time.monotonic()+120
    for name,file,info in items:
        if name in ignored: continue
        token=f'{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}'
        old=database.execute('select token,hash from files where root=? and path=?',(root,name)).fetchone()
        if old and old[0]==token and not full: digest=old[1]
        else:
            sha=hashlib.sha256();read_bytes=0
            with open(file,'rb') as source:
                while True:
                    data=source.read(65536)
                    if not data: break
                    read_bytes+=len(data)
                    if read_bytes>info.st_size:raise ValueError('WDX_CONCURRENT_CHANGE: Source grew during hashing')
                    if time.monotonic()>deadline:raise ValueError('WDX_TIMEOUT: Source hash deadline exceeded')
                    sha.update(data)
            after=file.stat()
            if read_bytes!=info.st_size or after.st_ino!=info.st_ino or after.st_mtime_ns!=info.st_mtime_ns or after.st_ctime_ns!=info.st_ctime_ns:raise ValueError('WDX_CONCURRENT_CHANGE: Source changed during hashing')
            digest=sha.hexdigest();database.execute('insert or replace into files values(?,?,?,?)',(root,name,token,digest))
        metadata_bytes+=len(os.fsencode(name))+160
        if metadata_bytes>6*1024*1024 or len(files)>=20000:raise ValueError('WDX_INDEX_LIMIT: inventory too large; select Source paths')
        files.append({'path':name,'size':info.st_size,'hash':digest})
    database.commit();database.close()
    return {'files':files,'skippedLarge':large}

def bounded_hash(file,maximum=4*1024*1024):
    total=0;digest=hashlib.sha256()
    with open(file,'rb') as source:
        while True:
            chunk=source.read(min(65536,maximum-total+1))
            if not chunk:break
            total+=len(chunk)
            if total>maximum:return None
            digest.update(chunk)
    return digest.hexdigest()

def file_operation(action,root,payload,policy):
    name=payload.get('path','.')
    if secret(name): raise ValueError('WDX_PATH: credential content unavailable')
    file=safe(root,name,action=='file.write')
    if action=='file.list':
        limit=min(200,max(1,int(payload.get('limit',40))));entries=[]
        with os.scandir(file) as iterator:
            for item in iterator:
                if item.is_symlink() or secret(item.name): continue
                relative=os.path.relpath(item.path,root)
                if relative!='.' and not eligible(relative,0,policy): continue
                entries.append({'name':item.name,'type':'directory' if item.is_dir(follow_symlinks=False) else 'file'})
                if len(entries)>=limit: break
        return {'path':name,'entries':entries,'limited':len(entries)>=limit,'untrusted':True}
    if action=='file.read':
        limit=min(262144,max(1,int(payload.get('maxBytes',65536))));start=max(1,int(payload.get('startLine',1)));end=int(payload.get('endLine',start+200))
        if not file.is_file(): raise ValueError('WDX_PATH: expected regular file')
        protected=any(part in policy['protectedNames'] or part=='node_modules' for part in pathlib.Path(name).parts) or any(name==p or name.startswith(p+'/') for p in policy['exclude'])
        if protected and not payload.get('preview'): return {'path':name,'size':file.stat().st_size,'protected':True,'untrusted':True}
        if end<start:raise ValueError('WDX_USAGE: invalid range')
        body=bytearray();line_number=0;truncated=False;scanned=0
        with open(file,'rb') as source:
            while line_number<end:
                line=source.readline(limit+1);scanned+=len(line)
                if not line: break
                if scanned>8*1024*1024:truncated=True;break
                line_number+=1
                if not line.endswith(b'\n') and len(line)>limit:
                    if line_number>=start:body.extend(line[:limit-len(body)])
                    truncated=True;break
                if line_number<start: continue
                if len(body)+len(line)>limit: body.extend(line[:limit-len(body)]);truncated=True;break
                body.extend(line)
            if source.read(1): truncated=True
        return {'path':name,'content':bytes(body).decode('utf-8',errors='ignore'),'startLine':start,'endLine':line_number,'truncated':truncated,'size':file.stat().st_size,'hash':bounded_hash(file) if file.stat().st_size<=4*1024*1024 else None,'untrusted':True}
    if action=='file.search':
        pattern=payload.get('pattern','');matches=[];limit=min(200,max(1,int(payload.get('limit',100))));total=128;output_limit=min(262144,max(1,int(payload.get('maxBytes',65536))))
        if not pattern or len(pattern)>1024:raise ValueError('WDX_USAGE: bounded pattern required')
        expression=None
        names=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).stdout.split(b'\0')
        nonempty=[x for x in names if x];ignored=set(git(root,['check-ignore','--no-index','-z','--stdin'],b'\0'.join(nonempty)+b'\0').stdout.split(b'\0')) if nonempty else set()
        selected=[]
        for raw in dict.fromkeys(nonempty):
            if raw in ignored:continue
            relative=os.fsdecode(raw)
            if name!='.' and relative!=name and not relative.startswith(name.rstrip('/')+'/'):continue
            try:
                target=safe(root,relative)
                if target.is_file() and eligible(relative,target.stat().st_size,policy):selected.append(relative)
            except (OSError,ValueError):continue
        if payload.get('regex'):
            if not selected:return {'matches':[],'truncated':False,'untrusted':True}
            result=bounded(['rg','--json','--max-count','100','-e',pattern,'--',*selected],root,maximum=1048576,timeout=10)
            if result.returncode>1:raise ValueError('WDX_SEARCH: '+result.stderr.decode(errors='replace'))
            for line in result.stdout.splitlines():
                record=json.loads(line)
                if record.get('type')=='match':
                    data=record['data'];item={'path':data['path'].get('text',''),'line':data['line_number'],'text':data['lines'].get('text','')[:200]};total+=len(dump(item))+1
                    if total>output_limit:return {'matches':matches,'truncated':True,'untrusted':True}
                    matches.append(item)
                    if len(matches)>=limit:break
            return {'matches':matches,'truncated':len(matches)>=limit,'untrusted':True}
        for relative in selected:
            prefix=payload.get('path','.')
            if prefix!='.' and relative!=prefix and not relative.startswith(prefix.rstrip('/')+'/'):continue
            try:
                target=safe(root,relative)
                if not target.is_file() or not eligible(relative,target.stat().st_size,policy): continue
                with open(target,'rb') as source:
                    number=0
                    while True:
                        line=source.readline(262145)
                        if not line:break
                        number+=1
                        if len(line)>262144:
                            while line and not line.endswith(b'\n'):line=source.readline(262145)
                            continue
                        text=line.decode(errors='replace')
                        if (expression.search(text) if expression else pattern in text):
                            snippet=text.strip()[:200];item={'path':relative,'line':number,'text':snippet};total+=len(dump(item))+1
                            if total>output_limit: return {'matches':matches,'truncated':True,'untrusted':True}
                            matches.append(item)
                            if len(matches)>=limit: return {'matches':matches,'truncated':True,'untrusted':True}
            except (OSError,ValueError): continue
        return {'matches':matches,'truncated':False,'untrusted':True}
    raise ValueError('WDX_USAGE: unsupported file operation')

def transfer_directory(root,id):
    if not UUID.fullmatch(id):raise ValueError('WDX_PATH: invalid transaction ID')
    return private(private(private(pathlib.Path(root)/'.werodex')/'transfer')/id)

def file_entry(file):
    if not file.exists() and not file.is_symlink():return None
    if file.is_symlink() or not file.is_file():raise ValueError('WDX_PATH: regular non-symlink file required')
    before=file.stat();digest=hashlib.sha256();size=0
    with open(file,'rb') as source:
        for data in iter(lambda:source.read(65536),b''):
            size+=len(data);digest.update(data)
    after=file.stat()
    if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or size!=before.st_size:raise ValueError('WDX_CONCURRENT_CHANGE: transfer file changed while hashing')
    return {'size':size,'hash':digest.hexdigest()}

def open_parent(root,name,create=False):
    # Pin each directory to an fd so rename cannot follow replaced parent symlinks.
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        parts=pathlib.PurePosixPath(name).parts
        for part in parts[:-1]:
            if create:
                try:os.mkdir(part,0o755,dir_fd=fd)
                except FileExistsError:pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
        return fd,parts[-1]
    except:os.close(fd);raise

def transaction_action(name,root,payload,policy):
    boundary(root);id=payload['id'];directory=transfer_directory(root,id)
    files=payload.get('files',[])
    for item in files:
        p=item['path']
        if not isinstance(p,str) or p.startswith('/') or any(x in ('','.', '..') for x in p.split('/')) or chr(92) in p or chr(0) in p or secret(p) or not eligible(p,item['source']['size'],policy):raise ValueError('WDX_TRANSFER_POLICY: invalid Source transfer')
        safe(root,p,True)
    if name=='transfer.prepare':
        # Keep owned transaction state out of Git status without editing user rule files.
        exclude=os.path.abspath(os.path.join(root,git(root,['rev-parse','--git-path','info/exclude']).stdout.decode().strip()))
        if os.path.realpath(exclude)!=exclude:raise ValueError('WDX_PATH: unsafe Git exclude file')
        pathlib.Path(exclude).parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(exclude,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX);info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size>1024*1024:raise ValueError('WDX_PATH: bounded regular Git exclude file required')
            content=os.read(fd,1024*1024)
            if b'.werodex/' not in content.splitlines():os.write(fd,(b'' if not content or content.endswith(bytes([10])) else bytes([10]))+b'.werodex/'+bytes([10]))
        finally:os.close(fd)
        private(directory/'incoming');private(directory/'old')
        for item in files:
            for folder in ('incoming','old'):
                target=directory/folder/item['path'];target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        return {'directory':str(directory)}
    if name=='transfer.inspect':
        result=[]
        for item in files:
            record_file=directory/(hashlib.sha256(item['path'].encode()).hexdigest()+'.json');record=load(record_file,{})
            folder=record.get('oldFolder','old')
            if folder not in ('old','incoming'):raise ValueError('WDX_PATH: invalid recovery folder')
            actual=file_entry(safe(str(directory/folder),item['path'],True))
            if record.get('state')=='publishing':
                # A crash may land between exchange and journaling. Inspect both locations;
                # archive the displaced inode without repeating the exchange.
                incoming=file_entry(safe(str(directory/'incoming'),item['path'],True))
                if actual is None and incoming is not None and incoming!=item['source']:
                    actual=incoming;folder='incoming'
                published=actual is not None or (incoming is None and file_entry(safe(root,item['path'],True))==item['source'])
                record={**record,'state':'unknown','published':True if published else None,'old':actual,'oldFolder':folder};atomic(record_file,record)
            result.append({'path':item['path'],**record,'old':actual if actual is not None else record.get('old'),'oldFolder':folder})
        return {'files':result}
    if name=='transfer.cleanup':
        # Verify all retained versions before deleting any; an editor may still own a displaced fd.
        for item in files:
            folder=item.get('oldFolder','old')
            if folder not in ('old','incoming'):raise ValueError('WDX_PATH: invalid recovery folder')
            old=safe(str(directory/folder),item['path'],True)
            actual=file_entry(old)
            if actual is not None and actual!=item.get('old'):raise ValueError('WDX_CONCURRENT_CHANGE: displaced file changed after archive; recovery retained')
        for item in files:
            for folder in ('incoming','old'):
                file=safe(str(directory/folder),item['path'],True)
                if file.exists():file.unlink()
        return {}
    if name!='transfer.commit':raise ValueError('WDX_USAGE: unsupported transaction action')
    rename=getattr(ctypes.CDLL(None,use_errno=True),'renameat2',None)
    if rename is None:raise ValueError('WDX_ATOMIC_UNSUPPORTED: renameat2 unavailable')
    rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
    results=[]
    lock=os.open(safe(root,'.werodex/transfer/publish.lock',True),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        # Recheck policy at publication, including endpoint ignore rules and target size.
        for item in files:
            p=item['path'];target=safe(root,p,True);old=file_entry(target)
            ignored=git(root,['check-ignore','--no-index','-q','--',p]).returncode
            if ignored!=1 or (old and not eligible(p,old['size'],policy)):raise ValueError('WDX_TRANSFER_POLICY: destination policy changed')
        for item in files:
            p=item['path'];record_file=directory/(hashlib.sha256(p.encode()).hexdigest()+'.json')
            if record_file.exists():raise ValueError('WDX_REQUEST_UNKNOWN: transaction publication already attempted; inspect before recovery')
            incoming=safe(str(directory/'incoming'),p);target=safe(root,p,True)
            if file_entry(incoming)!=item['source']:raise ValueError('WDX_CONCURRENT_CHANGE: staged Source changed')
            old=file_entry(target)
            if old!=item.get('target'):
                atomic(record_file,{'state':'conflict','published':False,'old':None});results.append({'path':p,'state':'conflict','published':False,'old':None});break
            if old:os.chmod(incoming,stat.S_IMODE(target.stat().st_mode))
            target_fd,base=open_parent(root,p,True);stage_fd,stage_base=open_parent(str(directory/'incoming'),p)
            try:
                atomic(record_file,{'state':'publishing','published':None})
                if rename(stage_fd,os.fsencode(stage_base),target_fd,os.fsencode(base),2 if old else 1):
                    code=ctypes.get_errno()
                    if code in (errno.EEXIST,errno.ENOENT):
                        atomic(record_file,{'state':'conflict','published':False,'old':None});results.append({'path':p,'state':'conflict','published':False,'old':None});break
                    raise ValueError('WDX_ATOMIC_UNSUPPORTED: '+os.strerror(code))
                if old:
                    # The exchanged inode is the version actually overwritten, not an earlier snapshot.
                    displaced=directory/'old'/p;os.replace(incoming,displaced);actual=file_entry(displaced)
                else:actual=None
                state='published' if actual==item.get('target') else 'conflict'
                record={'state':state,'published':True,'old':actual};atomic(record_file,record);results.append({'path':p,**record})
                if state=='conflict':break
            finally:os.close(target_fd);os.close(stage_fd)
        return {'files':results,'conflict':any(x['state']=='conflict' for x in results)}
    finally:os.close(lock)

def job_directory(workspace,id):
    if not UUID.fullmatch(id): raise ValueError('WDX_JOB: invalid job ID')
    return pathlib.Path.home()/'.local/state/werodex/jobs'/workspace/id

def job_info(workspace,id):
    directory=job_directory(workspace,id);meta=load(directory/'job.json')
    if meta:
        exit_file=directory/'exit'
        if exit_file.exists():
            code=int(exit_file.read_text().strip());meta.update(status='completed' if code==0 else 'failed',exitCode=code)
        command=meta.get('command','').encode()
        return {**{key:value for key,value in meta.items() if key!='argv'},'command':command[:2048].decode(errors='ignore'),'commandTruncated':len(command)>2048}
    if not directory.is_dir(): raise ValueError('WDX_JOB: job not found')
    def text(name):
        try:
            with open(directory/name) as source:return source.read(2048).strip()
        except OSError: return ''
    code=text('exit');live=subprocess.run(['tmux','has-session','-t','wdx-'+id],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    return {'id':id,'command':text('command'),'started':text('started'),'pid':int(text('pid') or 0),'status':('completed' if int(code)==0 else 'failed') if code else ('running' if live else 'unknown'),'exitCode':int(code) if code else None,'logPath':str(directory),'workspace':workspace,'runtime':'/tmp/werodex'}

class RingLog:
    def __init__(self,directory,limit):
        self.directory=directory;self.limit=limit;self.chunks=collections.deque();self.offset=0;self.bytes=0;self.number=0;self.current=None;self.last_index=0
        self.segment=min(1024*1024,max(65536,limit//4))
    def write(self,data):
        if len(data)>self.limit: self.offset+=len(data)-self.limit;data=data[-self.limit:]
        while self.chunks and self.bytes+len(data)>self.limit:
            item=self.chunks.popleft();self.bytes-=item['size']
            if self.current and self.current[0]==item['name']: self.current[1].close();self.current=None
            (self.directory/item['name']).unlink(missing_ok=True)
        if not self.current or self.chunks[-1]['size']+len(data)>self.segment:
            if self.current: self.current[1].close()
            name=f'part-{self.number:012d}';self.number+=1
            stream=open(self.directory/name,'xb',buffering=0);os.chmod(self.directory/name,0o600)
            self.current=(name,stream);self.chunks.append({'name':name,'start':self.offset,'size':0})
        self.current[1].write(data);self.chunks[-1]['size']+=len(data);self.offset+=len(data);self.bytes+=len(data)
        if time.monotonic()-self.last_index>.1: self.flush_index()
    def flush_index(self):
        atomic(self.directory/'log-index.json',{'start':self.chunks[0]['start'] if self.chunks else self.offset,'end':self.offset,'bytes':self.bytes,'chunks':list(self.chunks)});self.last_index=time.monotonic()
    def close(self):
        if self.current:self.current[1].close()
        self.flush_index()

async def supervise(directory):
    directory=private(directory);meta=load(directory/'job.json');ring=RingLog(directory,meta['limit'])
    try:process=await asyncio.create_subprocess_exec(*meta['argv'],cwd=meta['root'],stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT,start_new_session=True,limit=65536)
    except OSError as error:
        ring.write(str(error).encode());ring.close();(directory/'exit').write_text('127');meta.update(status='failed',exitCode=127);atomic(directory/'job.json',meta);return
    meta['pid']=process.pid;atomic(directory/'job.json',meta);(directory/'pid').write_text(str(process.pid))
    loop=asyncio.get_running_loop()
    def terminate():
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:pass
    for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):loop.add_signal_handler(sig,terminate)
    while True:
        chunk=await process.stdout.read(CHUNK)
        if not chunk:break
        ring.write(chunk)
    code=await process.wait();ring.close();code=code if code>=0 else 128-code
    atomic(directory/'job.json',{**meta,'status':'completed' if code==0 else 'failed','exitCode':code});(directory/'exit.tmp').write_text(str(code));os.replace(directory/'exit.tmp',directory/'exit')

def git_snapshot(root,overview=False,paths=None):
    boundary(root)
    head=bounded(['git','rev-parse','--verify','HEAD'],root)
    if head.returncode:head=None
    status=git(root,['--literal-pathspecs','status','--porcelain','-z','--untracked-files=all',*(['--',*paths] if paths else [])]).stdout
    out={'head':head.stdout.decode().strip() if head else None,'dirty':bool(status)}
    if overview:
        branch=bounded(['git','symbolic-ref','--short','HEAD'],root)
        records=status.split(b'\0');display=[];i=0
        while i<len(records):
            record=records[i];i+=1
            if not record:continue
            display.append(record.decode(errors='replace'))
            if record[:2].find(b'R')>=0 or record[:2].find(b'C')>=0:i+=1
        graph=git(root,['log','--graph','--oneline','--decorate','-12']).stdout.decode(errors='replace') if head else '(no commits yet)'
        out.update(branch=branch.stdout.decode().strip(),graph=graph[:16384],statusCount=len(display),status='\n'.join(display[:40])[:16384])
    return out

async def action(name,payload,root,policy,state,emit):
    if name.startswith('transfer.'):return await asyncio.to_thread(transaction_action,name,root,payload,policy)
    if name in ('git.state','git.overview'):return await asyncio.to_thread(git_snapshot,root,name=='git.overview',payload.get('paths'))
    if name=='scan':return await asyncio.to_thread(scan,root,policy,state/'cache',payload.get('paths'),payload.get('full',False))
    if name.startswith('file.'):return await asyncio.to_thread(file_operation,name,root,payload,policy)
    workspace=payload.get('workspace','')
    if not re.fullmatch(r'[A-Za-z0-9-]+',workspace):raise ValueError('WDX_PATH: invalid workspace')
    if name=='job.start':
        argv=payload.get('argv')
        if not isinstance(argv,list) or not argv or any(not isinstance(word,str) or '\x00' in word for word in argv) or len(dump(argv))>512*1024:raise ValueError('WDX_JOB: bounded command argv required')
        id=str(uuid.uuid4());directory=private(job_directory(workspace,id));private(directory.parent)
        meta={'id':id,'argv':argv,'root':root,'limit':int(payload.get('limit',256*1024*1024)),'command':' '.join(argv),'started':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'pid':None,'status':'running','exitCode':None,'logPath':str(directory),'workspace':workspace,'runtime':payload.get('runtime','/tmp/werodex'),'retentionDays':payload.get('retentionDays',7)}
        atomic(directory/'job.json',meta);(directory/'command').write_text(meta['command']);(directory/'started').write_text(meta['started'])
        launch='exec '+__import__('shlex').join([sys.executable,str(pathlib.Path(__file__).absolute()),'job',str(directory)])
        result=await asyncio.create_subprocess_exec('tmux','new-session','-d','-s','wdx-'+id,launch,stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.PIPE)
        if await result.wait():raise ValueError('WDX_JOB: could not start tmux job')
        return {'id':id}
    if name=='job.list':
        base=pathlib.Path.home()/'.local/state/werodex/jobs'/workspace
        entries=heapq.nlargest(200,(x for x in base.iterdir() if x.is_dir() and not x.is_symlink() and UUID.fullmatch(x.name)),key=lambda p:p.stat().st_mtime) if base.exists() else []
        return {'jobs':[job_info(workspace,x.name) for x in entries[:min(200,payload.get('limit',50))]],'total':len(entries)}
    id=payload['id'];directory=job_directory(workspace,id)
    if name=='job.status':return job_info(workspace,id)
    if name=='job.wait':
        deadline=time.monotonic()+payload.get('timeout',3600)
        while time.monotonic()<deadline:
            info=job_info(workspace,id)
            if info['status']!='running':return info
            await asyncio.sleep(.1)
        return {**job_info(workspace,id),'timedOut':True}
    if name=='job.kill':
        info=job_info(workspace,id)
        if info.get('pid'):
            try:os.killpg(info['pid'],signal.SIGTERM)
            except ProcessLookupError:pass
            asyncio.get_running_loop().call_later(.5,kill_group,info['pid'],signal.SIGKILL)
        else:subprocess.run(['tmux','kill-session','-t','wdx-'+id],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return {'id':id}
    if name=='job.logs':
        job_info(workspace,id);index=load(directory/'log-index.json')
        limit=min(256*1024*1024,max(1,payload.get('maxBytes',65536)))
        if index:
            start=max(index['start'],payload.get('cursor',max(index['start'],index['end']-limit)));remaining=limit;position=start
            for chunk in index['chunks']:
                if chunk['start']+chunk['size']<=start:continue
                try:
                    with open(directory/chunk['name'],'rb') as source:
                        offset=max(0,start-chunk['start']);source.seek(offset)
                        while remaining>0:
                            data=source.read(min(CHUNK,remaining))
                            if not data:break
                            await emit(b'O',data);position+=len(data);remaining-=len(data)
                except FileNotFoundError:continue
                if not remaining:break
            return {'cursor':position,'nextCursor':position,'start':index['start'],'end':index['end'],'gap':payload.get('cursor',start)<index['start'],'untrusted':True}
        # Legacy chunks: seek from the end instead of reading all retained bytes.
        files=sorted(directory.glob('part-*'));selected=[];needed=limit
        for file in reversed(files):
            size=file.stat().st_size;offset=max(0,size-needed);selected.append((file,offset));needed-=size-offset
            if needed<=0:break
        for file,offset in reversed(selected):
            with open(file,'rb') as source:
                source.seek(offset)
                while True:
                    data=source.read(CHUNK)
                    if not data:break
                    await emit(b'O',data)
        return {'legacy':True,'untrusted':True}
    raise ValueError('WDX_USAGE: unsupported operation')

async def frame(writer,kind,data):
    writer.write(struct.pack('!I',len(data)+1)+kind+data);await writer.drain()
async def message(writer,value):
    data=dump(value)
    if len(data)>8*1024*1024:raise ValueError('WDX_OUTPUT_LIMIT: metadata response too large')
    for start in range(0,len(data),CHUNK):await frame(writer,b'M',data[start:start+CHUNK])
    await frame(writer,b'J',b'')
async def read_message(reader):
    body=bytearray()
    while True:
        n=struct.unpack('!I',await reader.readexactly(4))[0]
        if n<1 or n>MAX_FRAME:raise ValueError('invalid frame')
        packet=await reader.readexactly(n)
        if packet[:1]==b'J':return json.loads(body)
        if packet[:1]!=b'M' or len(body)+len(packet)-1>MAX_MESSAGE:raise ValueError('message limit')
        body.extend(packet[1:])

def prune_jobs():
    base=pathlib.Path.home()/'.local/state/werodex/jobs'
    if not base.is_dir() or base.is_symlink():return
    for workspace in base.iterdir():
        if not workspace.is_dir() or workspace.is_symlink() or not re.fullmatch(r'[A-Za-z0-9-]+',workspace.name):continue
        for directory in workspace.iterdir():
            if not directory.is_dir() or directory.is_symlink() or not UUID.fullmatch(directory.name):continue
            meta=load(directory/'job.json',{});exit_file=directory/'exit'
            if exit_file.is_file() and time.time()-exit_file.stat().st_mtime>max(1,meta.get('retentionDays',7))*86400:shutil.rmtree(directory)

class Worker:
    def __init__(self,state):
        self.state=private(state);self.results=private(self.state/'results');self.tasks={};self.processes={};self.cancelled=set();self.last_gc=0;self.ledger=sqlite3.connect(str(self.state/'requests.sqlite'))
        self.ledger.execute('create table if not exists expired(id text primary key)');self.result_bytes=0;self.last_job_gc=0
        self.collect()
    def collect(self,target=64*1024*1024):
        now=time.time();terminal=[];total=0
        for directory in self.results.iterdir():
            if not directory.is_dir() or directory.is_symlink():continue
            meta=load(directory/'result.json')
            if not meta:continue
            size=sum(x.stat().st_size for x in directory.iterdir() if x.is_file())
            total+=size
            if meta.get('state')=='running' and directory.name not in self.tasks:atomic(directory/'result.json',{'state':'unknown','code':1});continue
            if meta.get('state') not in ('running','unknown'):terminal.append((directory.stat().st_mtime,directory,size))
        for timestamp,directory,size in sorted(terminal):
            if now-timestamp<3600 and total<=target:continue
            for file in directory.iterdir():
                if file.name!='result.json':file.unlink(missing_ok=True)
            self.ledger.execute('insert or ignore into expired values(?)',(directory.name,));self.ledger.commit()
            (directory/'result.json').unlink(missing_ok=True);directory.rmdir();total-=size
        self.result_bytes=total
    async def maintenance(self):
        while True:
            await asyncio.sleep(60);self.collect()
            if self.state.name=='0' and time.time()-self.last_job_gc>3600:
                self.last_job_gc=time.time();await asyncio.to_thread(prune_jobs)
    async def serve(self,reader,writer):
        peer=writer.get_extra_info('socket').getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)
        if struct.unpack('3i',peer)[1]!=os.getuid():writer.close();return
        await message(writer,{'ready':3});pending=None
        async def handle(request):
            id=request['requestId']
            if not UUID.fullmatch(id):raise ValueError('invalid request ID')
            async def emit(kind,data):
                if not writer.is_closing():
                    try:await frame(writer,kind,data)
                    except (ConnectionError,BrokenPipeError):pass
            if request.get('query'):
                slot=str(request.get('slot',0))
                if slot not in ('0','1'):raise ValueError('invalid slot')
                other=self.state.parent/slot/'results'/id;meta=load(other/'result.json')
                if not meta:
                    expired=False;ledger=self.state.parent/slot/'requests.sqlite'
                    if ledger.exists():
                        database=sqlite3.connect('file:'+str(ledger)+'?mode=ro',uri=True)
                        expired=database.execute('select 1 from expired where id=?',(id,)).fetchone() is not None;database.close()
                    meta={'state':'expired' if expired else 'unknown','code':1}
                if meta.get('state') not in ('running','unknown','missing','expired'):
                    for kind,name in ((b'O','out'),(b'E','err')):
                        try:
                            with open(other/name,'rb') as source:
                                while True:
                                    data=source.read(CHUNK)
                                    if not data:break
                                    await emit(kind,data)
                        except FileNotFoundError:pass
                await message(writer,{**meta,'requestId':id});return
            if self.ledger.execute('select 1 from expired where id=?',(id,)).fetchone():await message(writer,{'requestId':id,'state':'expired','code':1});return
            if len(self.tasks)>2 or (self.state/'requests.sqlite').stat().st_size>16*1024*1024 or self.result_bytes+16*1024*1024>64*1024*1024:
                self.collect(48*1024*1024)
                if self.result_bytes+16*1024*1024>64*1024*1024 or len(self.tasks)>2 or (self.state/'requests.sqlite').stat().st_size>16*1024*1024:await message(writer,{'requestId':id,'state':'rejected','code':1,'error':'WDX_RESULT_LIMIT: durable recovery quota reached; archive owned state explicitly'});return
            if sum(1 for _ in self.results.iterdir())>=10000:await message(writer,{'requestId':id,'state':'rejected','code':1,'error':'WDX_RESULT_LIMIT: unresolved/result record quota reached'});return
            directory=private(self.results/id);old=load(directory/'result.json')
            if old:
                await message(writer,{**old,'requestId':id});return
            atomic(directory/'result.json',{'state':'running','code':1})
            try:
                if request.get('action')=='program':meta=await self.execute({**request,'argv':request['payload']['argv'],'cwd':request['root']},directory,emit)
                elif request.get('action'):
                    result=await action(request['action'],request.get('payload',{}),request['root'],request['policy'],self.state,emit)
                    meta={'state':'completed','code':0,'value':result}
                else:meta=await self.execute(request,directory,emit)
            except asyncio.CancelledError:meta={'state':'cancelled','code':130}
            except Exception as error:meta={'state':'completed','code':1,'error':str(error)}
            stored=meta if len(dump(meta))<=65536 else {**{key:value for key,value in meta.items() if key!='value'},'recoveryValueOmitted':True}
            atomic(directory/'result.json',stored);self.result_bytes+=sum(x.stat().st_size for x in directory.iterdir() if x.is_file())
            if not writer.is_closing():
                try:await message(writer,{**meta,'requestId':id})
                except (ConnectionError,BrokenPipeError):pass
            if time.time()-self.last_gc>60:self.last_gc=time.time();self.collect()
        try:
            while True:
                request=await read_message(reader)
                if request.get('cancel'):
                    id=request['cancel'];process=self.processes.get(id)
                    if process:
                        self.cancelled.add(id)
                        asyncio.get_running_loop().call_later(.2,kill_group,process.pid,signal.SIGKILL)
                        try:os.killpg(process.pid,signal.SIGTERM)
                        except ProcessLookupError:pass
                    elif id in self.tasks:self.tasks[id].cancel()
                    continue
                if pending and not pending.done():raise ValueError('worker channel busy')
                pending=asyncio.create_task(handle(request));self.tasks[request['requestId']]=pending
                def completed(task,id=request['requestId']):
                    self.tasks.pop(id,None)
                    if not task.cancelled():task.exception()
                pending.add_done_callback(completed)
        except (asyncio.IncompleteReadError,ConnectionError,BrokenPipeError):pass
        finally:writer.close()
    async def execute(self,request,directory,emit):
        script=directory/'script.sh';script.write_text(request.get('script') or ':\n');os.chmod(script,0o600)
        argv=request.get('argv') or ['bash','--noprofile','--norc',str(script),*request.get('args',[])]
        process=await asyncio.create_subprocess_exec(*argv,cwd=request.get('cwd'),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True,limit=65536)
        self.processes[request['requestId']]=process
        budget=request.get('maxBytes',8*1024*1024);counts={b'O':0,b'E':0};overflow=False
        async def pump(stream,kind,name):
            nonlocal overflow
            with open(directory/name,'wb') as out:
                os.chmod(directory/name,0o600)
                while True:
                    chunk=await stream.read(CHUNK)
                    if not chunk:break
                    remaining=max(0,budget-counts[kind]);allowed=chunk[:remaining];counts[kind]+=len(chunk)
                    if out.tell()<8*1024*1024:out.write(allowed[:8*1024*1024-out.tell()])
                    if allowed:await emit(kind,allowed)
                    if counts[kind]>budget:overflow=True;terminate()
        def terminate():
            asyncio.get_running_loop().call_later(.2,kill_group,process.pid,signal.SIGKILL)
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
        pumps=[asyncio.create_task(pump(process.stdout,b'O','out')),asyncio.create_task(pump(process.stderr,b'E','err'))]
        timed=False
        try:await asyncio.wait_for(process.wait(),request['timeout']/1000)
        except asyncio.TimeoutError:timed=True;terminate()
        if timed or overflow:
            try:await asyncio.wait_for(process.wait(),.2)
            except asyncio.TimeoutError:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                await process.wait()
        # Reap pipe-owning descendants of short commands; tmux jobs are independent.
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:await asyncio.wait_for(asyncio.gather(*pumps),1)
        except asyncio.TimeoutError:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        script.unlink(missing_ok=True)
        self.processes.pop(request['requestId'],None)
        cancelled=request['requestId'] in self.cancelled;self.cancelled.discard(request['requestId'])
        return {'code':130 if cancelled else 124 if timed else 125 if overflow else process.returncode,'state':'cancelled' if cancelled else 'timeout' if timed else 'output-limit' if overflow else 'completed','stdoutBytes':counts[b'O'],'stderrBytes':counts[b'E'],'recoveryTruncated':max(counts.values())>8*1024*1024}

async def main():
    mode=sys.argv[1]
    if mode=='job':await supervise(sys.argv[2]);return
    if mode=='oneshot':
        request=json.load(sys.stdin);chunks=[]
        async def emit(kind,data):chunks.append((kind.decode(),base64.b64encode(data).decode()))
        value=await action(request['action'],request.get('payload',{}),request['root'],request['policy'],private(request['state']),emit)
        print(json.dumps({'value':value,'chunks':chunks}));return
    state=private(sys.argv[2]);sock=state/'worker.sock'
    if mode=='server':
        if sock.exists():sock.unlink()
        worker=Worker(state);server=await asyncio.start_unix_server(worker.serve,path=str(sock),limit=65536);os.chmod(sock,0o600)
        asyncio.create_task(worker.maintenance())
        async with server:await server.serve_forever()
    elif mode=='bridge':
        for attempt in range(100):
            try:reader,writer=await asyncio.open_unix_connection(str(sock));break
            except (FileNotFoundError,ConnectionRefusedError):await asyncio.sleep(.02)
        else:raise ValueError('worker unavailable')
        loop=asyncio.get_running_loop();stdin=asyncio.StreamReader(limit=65536);protocol=asyncio.StreamReaderProtocol(stdin);await loop.connect_read_pipe(lambda:protocol,sys.stdin.buffer)
        async def upstream():
            while True:
                data=await stdin.read(CHUNK)
                if not data:break
                writer.write(data);await writer.drain()
            writer.close()
        async def downstream():
            while True:
                data=await reader.read(CHUNK)
                if not data:break
                sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
        tasks=[asyncio.create_task(upstream()),asyncio.create_task(downstream())];await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
        for task in tasks:task.cancel()

if __name__=='__main__':
    os.umask(0o077)
    try:asyncio.run(main())
    except (BrokenPipeError,KeyboardInterrupt):pass
