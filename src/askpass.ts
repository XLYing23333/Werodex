#!/usr/bin/env node
import * as net from 'node:net';
const p=process.env.WERODEX_ASKPASS_SOCKET;if(!p)process.exit(1);
const s=net.createConnection(p);s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exit(1));
