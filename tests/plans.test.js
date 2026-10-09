const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {migratePlans,planDirectory}=require('../dist/plans');
const temp=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'wdx-plans-'));fs.mkdirSync(path.join(root,'.werodex'),{mode:0o700});return root;};
test('explicit plan migration repairs relative links and backlinks without moving overview documents',()=>{
 const root=temp(),base=path.join(root,'.werodex');try{
  fs.writeFileSync(path.join(base,'stage-plan.md'),'# Plan\n[other](other-plan.md)\n![image](assets/a.png)\n[Source](../src/a.py)\n`[example](other-plan.md)`\n');
  fs.writeFileSync(path.join(base,'other-plan.md'),'[stage](stage-plan.md#step)\n');fs.writeFileSync(path.join(base,'project-tree.md'),'[plan](stage-plan.md)\n');
  const dry=migratePlans(root,['.werodex/stage-plan.md','.werodex/other-plan.md'],true);assert.equal(dry.moves.length,2);assert.ok(!fs.existsSync(path.join(base,'plan')));assert.ok(fs.existsSync(path.join(base,'stage-plan.md')));
  migratePlans(root,['.werodex/stage-plan.md','.werodex/other-plan.md']);const plan=fs.readFileSync(path.join(base,'plan/stage-plan.md'),'utf8');
  assert.match(plan,/\[other\]\(other-plan.md\)/);assert.match(plan,/\!\[image\]\(\.\.\/assets\/a.png\)/);assert.match(plan,/\[Source\]\(\.\.\/\.\.\/src\/a.py\)/);assert.match(plan,/`\[example\]\(other-plan.md\)`/);
  assert.equal(fs.readFileSync(path.join(base,'project-tree.md'),'utf8'),'[plan](plan/stage-plan.md)\n');assert.equal(fs.statSync(path.join(base,'plan')).mode&0o777,0o700);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('migration rejects reserved files, symlinks and collisions and rolls back applied moves',()=>{
 const root=temp(),base=path.join(root,'.werodex');try{
  fs.writeFileSync(path.join(base,'project-tree.md'),'overview');assert.throws(()=>migratePlans(root,['.werodex/project-tree.md']),{code:'WDX_PLAN'});
  fs.writeFileSync(path.join(base,'a-plan.md'),'[b](b-plan.md)');fs.writeFileSync(path.join(base,'b-plan.md'),'b');fs.symlinkSync('a-plan.md',path.join(base,'link-plan.md'));assert.throws(()=>migratePlans(root,['.werodex/link-plan.md']),{code:'WDX_PLAN'});
  planDirectory(root);fs.writeFileSync(path.join(base,'plan/a-plan.md'),'existing');assert.throws(()=>migratePlans(root,['.werodex/a-plan.md']),{code:'WDX_PLAN'});fs.unlinkSync(path.join(base,'plan/a-plan.md'));
  const link=fs.linkSync;fs.linkSync=(src,dst)=>{if(dst.endsWith('/b-plan.md'))throw Error('injected failure');return link(src,dst);};try{assert.throws(()=>migratePlans(root,['.werodex/a-plan.md','.werodex/b-plan.md']),/injected failure/);}finally{fs.linkSync=link;}
  assert.equal(fs.readFileSync(path.join(base,'a-plan.md'),'utf8'),'[b](b-plan.md)');assert.equal(fs.readFileSync(path.join(base,'b-plan.md'),'utf8'),'b');assert.deepEqual(fs.readdirSync(path.join(base,'plan')),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
