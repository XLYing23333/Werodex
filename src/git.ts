import * as fs from 'node:fs';
import {Result,run,WdxError} from './core';

// Compare working-tree roots, not .git directories: linked worktrees use a file.
export async function localGitRoot(root:string,allowMissing=false,missingCode='WDX_GIT'){
 const result=await run('git',['rev-parse','--show-toplevel'],{cwd:root,env:{...process.env,LC_ALL:'C'}});
 if(result.code){
  if(allowMissing&&result.stderr.includes('not a git repository'))return undefined;
  throw new WdxError(missingCode,result.stderr||'Cannot locate project Git repository');
 }
 const top=fs.realpathSync(result.stdout.trim());
 if(top!==fs.realpathSync(root))throw new WdxError('WDX_GIT_PARENT',`Project ${root} belongs to parent Git repository ${top}. Run git init -b main in the project directory to create an independent repository, then retry.`);
 return top;
}

// Every remote Git operation uses this guard before reading or writing Git state.
export function gitBoundaryScript(allowMissing=false){return `wdx_git_missing=0
if wdx_git_top=$(LC_ALL=C git -C "$1" rev-parse --show-toplevel 2>&1); then
 wdx_git_top=$(realpath -e -- "$wdx_git_top")
 wdx_project_root=$(realpath -e -- "$1")
 [[ "$wdx_git_top" = "$wdx_project_root" ]] || { echo "WDX_GIT_PARENT: Project $1 belongs to parent Git repository $wdx_git_top. Run git init -b main in the project directory, then retry." >&2; exit 21; }
else
 ${allowMissing?'if [[ "$wdx_git_top" = *"not a git repository"* ]]; then wdx_git_missing=1; else echo "$wdx_git_top" >&2; exit 20; fi':'echo "WDX_GIT: $wdx_git_top" >&2; exit 20;'}
fi
`;}

export function assertGitResult(result:Result,fallback='WDX_GIT'){
 if(result.code)throw new WdxError(result.stderr.includes('WDX_GIT_PARENT:')?'WDX_GIT_PARENT':fallback,result.stderr||'Project Git check failed');
}
