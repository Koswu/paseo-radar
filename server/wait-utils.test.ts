import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWaitScriptFailure,
  hasWaitPendingExitCode,
  WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS,
  WAIT_SCRIPT_PENDING_EXIT_CODE,
} from "./wait-utils.ts";

test("hasWaitPendingExitCode detects explicit exit 10 / return 10", () => {
  assert.equal(hasWaitPendingExitCode("if [ \"$ok\" = \"1\" ]; then exit 0; fi\nexit 10"), true);
  assert.equal(hasWaitPendingExitCode("check_fn || return 10"), true);
  assert.equal(hasWaitPendingExitCode("[ \"$s\" = \"done\" ] && exit 0 || exit 10"), true);

  assert.equal(hasWaitPendingExitCode("exit 1"), false);
  assert.equal(hasWaitPendingExitCode("exit 100"), false);
  assert.equal(hasWaitPendingExitCode("echo 10\nexit 0"), false);
});

test("classifyWaitScriptFailure separates pending, fast_fail, and transient errors", () => {
  const pending = classifyWaitScriptFailure({ code: WAIT_SCRIPT_PENDING_EXIT_CODE });
  assert.equal(pending.kind, "pending");
  assert.equal(pending.threshold, 0);
  assert.equal(pending.exitCode, 10);

  for (const code of [2, 126, 127]) {
    const fastFail = classifyWaitScriptFailure({ code });
    assert.equal(fastFail.kind, "fast_fail");
    assert.equal(fastFail.threshold, 1);
    assert.equal(fastFail.exitCode, code);
  }

  const genericExit1 = classifyWaitScriptFailure({ code: 1 });
  assert.equal(genericExit1.kind, "transient");
  assert.equal(genericExit1.threshold, WAIT_SCRIPT_MAX_CONSECUTIVE_ERRORS);
  assert.equal(genericExit1.exitCode, 1);

  const networkErr = classifyWaitScriptFailure({ code: 6 });
  assert.equal(networkErr.kind, "transient");
  assert.equal(networkErr.threshold, 3);
  assert.equal(networkErr.exitCode, 6);

  const timedOut = classifyWaitScriptFailure({ code: 10, killed: true });
  assert.equal(timedOut.kind, "transient");
  assert.equal(timedOut.statusTag, "脚本超时");
  assert.equal(timedOut.threshold, 3);
});
