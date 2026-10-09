import {Writable} from 'node:stream';
import {once} from 'node:events';
import {WdxError} from './core';
export const FRAME_BYTES=65536;
export function packet(kind:string,data:Buffer){if(data.length+1>FRAME_BYTES)throw new WdxError('WDX_PROTOCOL','Frame too large');const header=Buffer.alloc(5);header.writeUInt32BE(data.length+1);header[4]=kind.charCodeAt(0);return Buffer.concat([header,data]);}
export async function writePacket(stream:Writable,kind:string,data:Buffer){
 if(stream.destroyed)throw new WdxError('WDX_IPC','Output stream closed');
 if(!stream.write(packet(kind,data)))await new Promise<void>((resolve,reject)=>{
  const clean=()=>{stream.off('drain',drain);stream.off('error',error);stream.off('close',closed);};
  const drain=()=>{clean();resolve();},error=(e:Error)=>{clean();reject(e);},closed=()=>error(new WdxError('WDX_IPC','Output stream closed'));
  stream.once('drain',drain);stream.once('error',error);stream.once('close',closed);
 });
}
export async function writeMessage(stream:Writable,value:unknown){const data=Buffer.from(JSON.stringify(value));if(data.length>20*1024*1024)throw new WdxError('WDX_IPC','Control request too large');for(let i=0;i<data.length;i+=32768)await writePacket(stream,'M',data.subarray(i,i+32768));await writePacket(stream,'J',Buffer.alloc(0));}
export class Frames {
 private header=Buffer.alloc(4);private headerBytes=0;private remaining=0;private payload?:Buffer;private payloadBytes=0;
 constructor(private receive:(kind:string,data:Buffer)=>void){}
 push(data:Buffer){let at=0;while(at<data.length){if(!this.remaining){const n=Math.min(4-this.headerBytes,data.length-at);data.copy(this.header,this.headerBytes,at,at+n);this.headerBytes+=n;at+=n;if(this.headerBytes<4)continue;this.remaining=this.header.readUInt32BE();this.headerBytes=0;if(this.remaining<1||this.remaining>FRAME_BYTES)throw new WdxError('WDX_PROTOCOL','Invalid frame length');this.payload=Buffer.allocUnsafe(this.remaining);this.payloadBytes=0;}
 const n=Math.min(this.remaining-this.payloadBytes,data.length-at);data.copy(this.payload!,this.payloadBytes,at,at+n);this.payloadBytes+=n;at+=n;if(this.payloadBytes===this.remaining){const value=this.payload!;this.remaining=0;this.payload=undefined;this.receive(String.fromCharCode(value[0]),value.subarray(1));}}
 }
}
