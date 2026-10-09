import {StringDecoder} from 'node:string_decoder';
export type OutputPolicy={maxLines:number;maxBytes:number;tailLines:number};
export const outputDefaults:OutputPolicy={maxLines:80,maxBytes:12288,tailLines:40};
export function truncateUtf8(value:string,maxBytes:number){const data=Buffer.from(value);if(data.length<=maxBytes)return value;return new StringDecoder('utf8').write(data.subarray(0,Math.max(0,maxBytes)));}
export function filterOutput(raw:string,policy=outputDefaults){
 policy={...outputDefaults,...policy};const limit=Math.max(0,policy.maxBytes);if(!limit)return '';
 const lines=raw.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/\r[^\n]*/g,'').split('\n').filter(x=>!/^\s*\d+%\|/.test(x));
 const collapsed:string[]=[];let previous='',count=0;
 for(const line of lines){if(line===previous&&line){count++;continue;}if(count)collapsed.push(`[previous line repeated ${count} times]`);collapsed.push(line);previous=line;count=0;}
 if(count)collapsed.push(`[previous line repeated ${count} times]`);
 const errors=collapsed.filter(x=>/error|fatal|traceback|failed|exception/i.test(x)).slice(-20),selected=collapsed.slice(-policy.tailLines);
 for(const line of errors)if(!selected.includes(line))selected.unshift(line);
 const text=selected.slice(-policy.maxLines).join('\n');if(Buffer.byteLength(text)<=limit)return text;
 const marker='\n[truncated]';return truncateUtf8(text,Math.max(0,limit-Buffer.byteLength(marker)))+truncateUtf8(marker,limit);
}
