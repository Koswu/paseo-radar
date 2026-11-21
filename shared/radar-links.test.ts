import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHeaderLinkGroups,
  resolveFallbackExternalUrl,
  shortUrlPreview,
  shouldShowStaticSourceBadge,
} from "./radar-links.ts";

test("resolveFallbackExternalUrl returns null when itemUrl is already in links", () => {
  const links = [
    { url: "https://linear.app/org/issue/ENG-204/" },
    { url: "https://gitlab.example.com/org/repo/-/merge_requests/42" },
  ];
  assert.equal(resolveFallbackExternalUrl("https://linear.app/org/issue/ENG-204", links), null);
});

test("resolveFallbackExternalUrl returns itemUrl when links is empty or excludes it", () => {
  assert.equal(
    resolveFallbackExternalUrl("https://linear.app/org/issue/ENG-204", []),
    "https://linear.app/org/issue/ENG-204",
  );
  assert.equal(
    resolveFallbackExternalUrl("https://linear.app/org/issue/ENG-204", [
      { url: "https://gitlab.example.com/org/repo/-/merge_requests/42" },
    ]),
    "https://linear.app/org/issue/ENG-204",
  );
});

test("resolveFallbackExternalUrl returns null for empty or nullish itemUrl", () => {
  assert.equal(resolveFallbackExternalUrl(null, []), null);
  assert.equal(resolveFallbackExternalUrl("   ", []), null);
});

test("buildHeaderLinkGroups puts known kinds first and merges unknown links at the end", () => {
  const groups = buildHeaderLinkGroups("calendar", null, [
    { kind: "link", label: "链接 1", url: "https://example.com/1" },
    { kind: "calendar", label: "Calendar", url: "https://slack.com/lists/1" },
    { kind: "link", label: "链接 2", url: "https://example.com/2" },
    { kind: "gitlab", label: "MR !1", url: "https://gitlab.example.com/mr/1" },
    { kind: "gitlab", label: "MR !2", url: "https://gitlab.example.com/mr/2" },
  ]);

  assert.deepEqual(
    groups.map((g) => ({ kind: g.kind, isUnknown: g.isUnknown, count: g.links.length })),
    [
      { kind: "calendar", isUnknown: false, count: 1 },
      { kind: "gitlab", isUnknown: false, count: 2 },
      { kind: "link", isUnknown: true, count: 2 },
    ],
  );
  assert.equal(shouldShowStaticSourceBadge("calendar", groups), false);
});

test("shouldShowStaticSourceBadge hides workspace/custom and already-linked sources", () => {
  assert.equal(shouldShowStaticSourceBadge("workspace", []), false);
  assert.equal(shouldShowStaticSourceBadge("custom", []), false);
  assert.equal(shouldShowStaticSourceBadge("gitlab", []), true);

  const wsGroups = buildHeaderLinkGroups("workspace", "https://example.com/doc", []);
  assert.equal(wsGroups.length, 1);
  assert.equal(wsGroups[0]?.isUnknown, true);
  assert.equal(wsGroups[0]?.kind, "link");
});

test("shortUrlPreview preserves host and leading path segment before truncating long IDs", () => {
  assert.equal(
    shortUrlPreview("https://assets.example.test/build-files/1305128514153437080"),
    "assets.example.test/build-files/…8514153437080",
  );
  assert.equal(
    shortUrlPreview("https://assets.example.test/assets/12061593151132800551"),
    "assets.example.test/assets/…061593151132800551",
  );
  assert.equal(shortUrlPreview("https://www.example.com/short"), "example.com/short");
});
