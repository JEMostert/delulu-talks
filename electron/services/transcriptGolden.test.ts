import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/golden-transcripts.json", import.meta.url),
    "utf8",
  ),
) as { id: string }[];

for (const fixture of fixtures) {
  test(`golden ${fixture.id}: source, correction and exact-block rewrite assembly preserve known bytes`, () => {
    // Isolate Electron's profile mock from other suites. Construct the actual
    // service but replace model loading/request output; no worker is started.
    const script = `
      import {mock} from "bun:test";
      import assert from "node:assert/strict";
      mock.module("electron",()=>({app:{isPackaged:false,getAppPath:()=>process.cwd()}}));
      const {AsrService} = await import(${JSON.stringify(new URL("./asr.ts", import.meta.url).href)});
      const {applyTranscriptEdit} = await import(${JSON.stringify(new URL("./storage.ts", import.meta.url).href)});
      const {DEFAULT_SETTINGS} = await import(${JSON.stringify(new URL("../../src/data.ts", import.meta.url).href)});
      const {personalize} = await import(${JSON.stringify(new URL("../../src/personalization.ts", import.meta.url).href)});
      const {deliveredText} = await import(${JSON.stringify(new URL("../../src/transcriptText.ts", import.meta.url).href)});
      const fixture = ${JSON.stringify(fixture)};
      // Versions are protected technical literals; they no longer enter rewriting.
      fixture.requests[1] = fixture.id === "dutch-code-block"
        ? {input:"Controleer café en versie", output:"Controleer café en versie"}
        : {input:"Keep C++ and snake_case at version", output:"Keep C++ and snake_case at version"};
      fixture.requests.push({input:".",output:"."});
      const original = {id:fixture.id,createdAt:1,durationMs:1000,text:fixture.source,
        personalizedText:personalize(fixture.source,fixture.words),model:"r2t2",
        language:fixture.language,source:"dictation",processingTimeMs:20};
      assert.equal(original.personalizedText,fixture.personalized);
      assert.equal(deliveredText(original),fixture.personalized);
      const corrected = applyTranscriptEdit(original,fixture.corrected);
      assert.equal(corrected.text,fixture.source);
      assert.equal(deliveredText(corrected),fixture.corrected);
      const settings = {...DEFAULT_SETTINGS,customWords:fixture.words,preloadModel:false,preloadMagicModel:false};
      const service = new AsrService({dataDirectory:"/unused-golden-fixture",venvDirectory:"/unused-golden-fixture/speech",
        magicVenvDirectory:"/unused-golden-fixture/writing",getSettings:()=>settings});
      service.ensureMagicLoaded = async()=>{};
      service.scheduleMagicIdle = ()=>{};
      const inputs=[];
      service.request = async(kind,command,request)=>{
        assert.equal(kind,"magic");assert.equal(command,"magicRewrite");
        const expected = fixture.requests[inputs.length];
        assert.equal(request.text,expected.input);
        assert(!request.text.includes(fixture.block),"Exact block must not reach the model");
        inputs.push(request.text);
        return {text:expected.output,processingTimeMs:10};
      };
      const result = await service.rewriteMagic({text:deliveredText(corrected),preset:"concise",instructions:"",allowInferences:false},settings);
      assert.deepEqual(inputs,fixture.requests.map(request=>request.input));
      assert.equal(result.text,fixture.rewritten);
      assert(result.text.includes(fixture.block));
      assert.equal(result.processingTimeMs,30);
      assert.equal(corrected.text,fixture.source);
      const applied={...corrected,magicText:result.text};
      assert.equal(deliveredText(applied),fixture.rewritten);
      const undo={...applied,magicText:null};
      assert.equal(deliveredText(undo),fixture.corrected);
      const restored=applyTranscriptEdit(undo,null);
      assert.equal(restored.text,fixture.source);
      assert.equal(deliveredText(restored),fixture.personalized);
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
}
