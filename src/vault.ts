import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {createCipheriv,createDecipheriv,randomBytes,scryptSync} from 'node:crypto';
import {WdxError,atomicJson,privateDirectory} from './core';
const file=()=>path.join(os.homedir(),'.config','werodex','vault.enc');
export function vaultExists(){return fs.existsSync(file());}
export function vaultCreate(password:string){if(!password)throw new WdxError('WDX_CREDENTIAL','Empty master password');if(vaultExists())throw new WdxError('WDX_CREDENTIAL','Vault already exists');vaultWrite(password,{});}
function vaultWrite(password:string,secrets:Record<string,string>){privateDirectory(path.dirname(file()));const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(password,salt,32),cipher=createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(secrets)),cipher.final()]);atomicJson(file(),{version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});}
export function vaultRead(password?:string):Record<string,string>{if(!password)throw new WdxError('WDX_CREDENTIAL_LOCKED','Vault locked; unlock interactively.');privateDirectory(path.dirname(file()),false);const stat=fs.lstatSync(file());if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==(process.getuid?.()??-1))throw new WdxError('WDX_CREDENTIAL','Insecure Vault ownership or permissions');const v=JSON.parse(fs.readFileSync(file(),'utf8'));try{const key=scryptSync(password,Buffer.from(v.salt,'base64'),32),d=createDecipheriv('aes-256-gcm',key,Buffer.from(v.iv,'base64'));d.setAuthTag(Buffer.from(v.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString());}catch{throw new WdxError('WDX_CREDENTIAL','Incorrect master password or corrupt vault');}}
export function vaultSet(password:string,id:string,secret:string){const v=vaultRead(password);v[id]=secret;vaultWrite(password,v);}
export function vaultDelete(password:string,id:string){const v=vaultRead(password);delete v[id];vaultWrite(password,v);}
