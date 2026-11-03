import test from "node:test";
import assert from "node:assert/strict";
import {RETIRED_TEST_MINTS,isPublicLaunch,publicActivity} from "../lib/public-directory.mjs";
test("retired NEARCAT tests are absent from directory/detail and activity without filtering future symbols",()=>{
 assert.equal(RETIRED_TEST_MINTS.size,2);
 for(const mint of RETIRED_TEST_MINTS)assert.equal(isPublicLaunch(mint),false);
 assert.equal(isPublicLaunch("future-nearcat-mint"),true);
 assert.deepEqual(publicActivity([...RETIRED_TEST_MINTS].map(mint=>({mint})).concat([{mint:"other",raw:"12"}])),[{mint:"other",raw:"12"}]);
});
