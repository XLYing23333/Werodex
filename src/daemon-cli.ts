#!/usr/bin/env node
import {serve} from './daemon';
if(process.argv.includes('--help')){console.log('werodexd: local Werodex SSH daemon (starts on demand)');process.exit(0);}
serve().catch(e=>{console.error(e.message);process.exitCode=1;});
