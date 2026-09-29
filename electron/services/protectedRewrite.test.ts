import { expect, test } from "bun:test";

const first = "  curl https://API.Example/Café --Header X-ID\r\n  # Keep 🚀\t";
const second = "  curl https://api.example/café --header x-id\r\n  # keep 🚀\t";
const words = [
  {
    id: "first",
    kind: "shortcut",
    term: "first snippet",
    soundsLike: "",
    replacement: first,
    enabled: true,
  },
  {
    id: "second",
    kind: "shortcut",
    term: "second snippet",
    soundsLike: "",
    replacement: second,
    enabled: true,
  },
];

for (const preset of ["polish", "concise", "structured", "prompt"] as const) {
  test(`${preset} preserves repeated case-colliding saved blocks and rejects partial model output`, () => {
    // Exercise the real service, isolating Electron's module mock from other
    // suites. Model loading/output are deterministic; no native worker starts.
    const script = `
      import {mock} from "bun:test";
      import assert from "node:assert/strict";
      mock.module("electron",()=>({app:{isPackaged:false,getAppPath:()=>process.cwd()}}));
      const {AsrService} = await import(${JSON.stringify(new URL("./asr.ts", import.meta.url).href)});
      const {DEFAULT_SETTINGS} = await import(${JSON.stringify(new URL("../../src/data.ts", import.meta.url).href)});
      const {splitForRewrite} = await import(${JSON.stringify(new URL("../../src/personalization.ts", import.meta.url).href)});
      const words=${JSON.stringify(words)}, first=${JSON.stringify(first)}, second=${JSON.stringify(second)}, preset=${JSON.stringify(preset)};
      const settings={...DEFAULT_SETTINGS,customWords:words,preloadModel:false,preloadMagicModel:false};
      const service=new AsrService({dataDirectory:"/unused-protected-fixture",venvDirectory:"/unused-protected-fixture/speech",magicVenvDirectory:"/unused-protected-fixture/writing",getSettings:()=>settings});
      service.ensureMagicLoaded=async()=>{};
      service.scheduleMagicIdle=()=>{};
      const source="Start.\\r\\n"+second+"\\n"+first+"\\r\\n"+second+"\\nFinish.";
      const expected="Changed start.\\r\\n"+second+"\\n"+first+"\\r\\n"+second+"\\nChanged finish.";
      assert.deepEqual(splitForRewrite(source,words).filter(part=>part.protected).map(part=>part.text),[second,first,second]);
      const calls=[];
      let fail=false;
      service.request=async(kind,command,request)=>{
        assert.equal(kind,"magic"); assert.equal(command,"magicRewrite");
        assert.equal(request.preset,preset); assert.equal(request.instructions,"Keep facts");
        assert.equal(request.allowInferences,false);
        assert(!request.text.includes("curl"),"Saved command bytes must never reach the model");
        calls.push(request.text);
        if(request.text==="Start.")return{text:"Changed start.",processingTimeMs:3};
        assert.equal(request.text,"Finish.");
        if(fail)throw new Error("fixture final-segment failure");
        return{text:"Changed finish.",processingTimeMs:5};
      };
      const request={text:source,preset,instructions:"Keep facts",allowInferences:false};
      const result=await service.rewriteMagic(request,settings);
      assert.equal(result.text,expected);
      assert.equal(result.processingTimeMs,8);
      assert.deepEqual(calls,["Start.","Finish."]);
      assert.equal(request.text,source);
      assert.equal(JSON.stringify(words),${JSON.stringify(JSON.stringify(words))});
      const alias=await service.rewriteMagic({...request,text:"Start.\\nSECOND SNIPPET\\nFinish."},settings);
      assert.equal(alias.text,"Changed start.\\n"+second+"\\nChanged finish.");
      const callsBeforeBlocks=calls.length;
      const blocksOnly=second+"\\r\\n"+first;
      const unchanged=await service.rewriteMagic({...request,text:blocksOnly},settings);
      assert.equal(unchanged.text,blocksOnly);
      const {deliveredText}=await import(${JSON.stringify(new URL("../../src/transcriptText.ts", import.meta.url).href)});
      assert.equal(deliveredText({magicText:blocksOnly}),blocksOnly);
      assert.equal(unchanged.processingTimeMs,0);
      assert.equal(calls.length,callsBeforeBlocks);
      fail=true;
      await assert.rejects(service.rewriteMagic(request,settings),/fixture final-segment failure/);
      assert.equal(request.text,source);
      fail=false;
      assert.equal((await service.rewriteMagic(request,settings)).text,expected);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
}

test("saved shortcut bytes survive settings write, reopen, expansion and rewrite protection", () => {
  const script = `
    import {mock} from "bun:test";
    import assert from "node:assert/strict";
    import {mkdtempSync,rmSync,readFileSync} from "node:fs";
    import {tmpdir} from "node:os";
    import {join} from "node:path";
    const profile=mkdtempSync(join(tmpdir(),"delulu-exact-settings-"));
    mock.module("electron",()=>({app:{isPackaged:false,getPath:()=>profile}}));
    const {StorageService}=await import(${JSON.stringify(new URL("./storage.ts", import.meta.url).href)});
    const {deliveredText}=await import(${JSON.stringify(new URL("../../src/transcriptText.ts", import.meta.url).href)});
    const {exportRecord}=await import(${JSON.stringify(new URL("./transcripts.ts", import.meta.url).href)});
    const {personalize,splitForRewrite}=await import(${JSON.stringify(new URL("../../src/personalization.ts", import.meta.url).href)});
    const block=${JSON.stringify(`\n${second}\r\n`)};
    const rule={...${JSON.stringify(words[1])},replacement:block};
    try {
      const storage=new StorageService();
      const saved=storage.updateSettings({...storage.getSettings(),customWords:[rule],keepHistory:true});
      assert.equal(saved.customWords[0].replacement,block);
      assert.equal(JSON.parse(readFileSync(join(profile,"settings.json"),"utf8")).customWords[0].replacement,block);
      const record={id:"exact-saved",createdAt:1,text:"second snippet",personalizedText:block,magicText:block,model:"r2t2",language:"en",source:"dictation",durationMs:1,processingTimeMs:1};
      storage.addHistory(record);
      const reopenedStorage=new StorageService();
      const persisted=reopenedStorage.getHistory()[0];
      assert.equal(persisted.personalizedText,block);
      assert.equal(persisted.magicText,block);
      assert.equal(deliveredText(persisted),block);
      assert.equal(exportRecord(persisted,"txt"),block+"\\n\\n--- Source transcript ---\\n\\nsecond snippet\\n");
      const reopened=reopenedStorage.getSettings();
      assert.equal(reopened.customWords[0].replacement,block);
      const source="Start.\\nsecond snippet\\nFinish.";
      const expanded="Start.\\n"+block+"\\nFinish.";
      assert.equal(personalize(source,reopened.customWords),expanded);
      assert.deepEqual(splitForRewrite(expanded,reopened.customWords).filter(part=>part.protected).map(part=>part.text),[block]);
    }finally{rmSync(profile,{recursive:true,force:true})}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", script]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
