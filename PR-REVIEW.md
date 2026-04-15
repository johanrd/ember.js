# PR Review: "Failing Test" PRs on emberjs/ember.js

Systematic review of open PRs with failing tests. Each was cherry-picked/recreated
on a local branch, modernized to current syntax, built, and tested against main.

## Summary

| PR     | Branch       | Status                 | Result                                                            |
| ------ | ------------ | ---------------------- | ----------------------------------------------------------------- |
| #18607 | `test/18607` | FIXED                  | `get` helper with `this.args` in glimmer component works now      |
| #16342 | `test/16342` | FIXED                  | Loading + redirect timing issue resolved by router rewrite        |
| #20442 | `test/20442` | STILL FAILS            | Empty `{}` QP passes, `undefined` QP fails                        |
| #20612 | `test/20612` | STILL FAILS            | Chained redirection fires model hooks incorrectly                 |
| #20630 | `test/20630` | STILL FAILS            | `{{on}}` modifier true->false->true toggle broken                 |
| #18167 | `test/18167` | STILL FAILS            | Forwarded element modifiers ignore specified order                |
| #18579 | `test/18579` | STILL FAILS            | replaceWith/transitionTo unnecessary refresh with refreshModel QP |
| #17451 | `test/17451` | STILL FAILS            | QP scoped to model not URL params                                 |
| #17831 | `test/17831` | STILL FAILS            | Model + QP + refreshModel causes async leakage                    |
| #17452 | `test/17452` | STILL FAILS (expected) | QP caching broken with resetNamespace                             |
| #16716 | `test/16716` | NOT YET TESTED         | Model cleared after aborting transition in afterModel             |
| #15832 | `test/15832` | STILL FAILS (expected) | Parent refreshModel triggers on child QP change                   |
| #15050 | `test/15050` | NOT YET TESTED         | Sticky QP in engine with loading template (timing issue in test)  |
| #19228 | `test/19228` | FIX ON BRANCH          | Improved error message for invalid fullName in registry           |
| #20830 | skipped      | INVALID                | Tests use wrong function signature (lookupComponentPair changed)  |
| #20826 | skipped      | LOW VALUE              | ComputedProperty tests already extensively covered                |

---

### FIX ON BRANCH (not yet PR'd)

#### #20959 — `@model` not stable during route transitions / willDestroy

- **Branch:** `test/20959` (3 commits: failing test, fix, test moved to smoke test)
- **Fix:** Stabilize `@model` by caching the value and only updating it when the new
  value is not undefined (during transition teardown, the model temporarily becomes undefined).
- **Note:** Required moving the `@glimmer/component` test to smoke tests since the internal
  test suite can't easily import `@glimmer/component`.

#### #19228 — Misleading error message for angle bracket nested components

- **Branch:** `test/19228`
- **Fix:** Changed `'fullName must be a proper full name'` to include the actual invalid
  name and guidance about using `::` separator with PascalCase.
- **Files:** `registry.ts`, `container.ts`, `registry_proxy.ts`

---

### STILL FAILING — Routing / Query Params cluster

These are all related to query param handling in the router. Many share root causes.

#### #18579 — replaceWith/transitionTo forces unnecessary refresh with refreshModel QP

- **Branch:** `test/18579`
- **Author:** Abram Booth <abram@cos.io>
- **Tests added to:** `replaceWith_test.js` and `transitionTo_test.js`
- **Bug:** When a parent route has `refreshModel: true` on a QP, transitioning between
  sibling child routes triggers the parent's model hook even though the QP didn't change.
- **Confirmed failing:** Both replaceWith and transitionTo variants fail.

#### #15832 — QP refreshModel on parent triggers for child QP change

- **Branch:** `test/15832`
- **Author:** Boudewijn van Groos <boudewijn@feedbackfruits.com>
- **Test added to:** `transitionTo_test.js`
- **Bug:** Changing a child route's QP via `transitionTo(queryParams)` incorrectly triggers
  the parent route's model hook when parent has `refreshModel: true` on a _different_ QP.
- **Related to:** #18579, #15801 — same root cause area.

#### #17451 — QP scoped to model not URL params

- **Branch:** `test/17451`
- **Author:** (modernized from original)
- **Test added to:** `query_params_test.js`
- **Bug:** URL stays at `/parent/1/child/2?query=foo` instead of correctly updating
  to `/parent/2/child/2` after transition.

#### #17452 — QP caching broken with resetNamespace

- **Branch:** `test/17452`
- **Author:** Peter Wagenet <peter.wagenet@gmail.com>
- **Test added to:** `query_params_test.js`
- **Bug:** When a route uses `resetNamespace: true`, the cache key calculator uses
  the current route name as prefix, which is incorrect. It looks up values from
  the wrong route hierarchy.

#### #17831 — Model + QP + refreshModel causes async leakage

- **Branch:** `test/17831`
- **Author:** (modernized from #16921)
- **Test added to:** `query_params_test.js`
- **Bug:** Transitioning with model + QP where parent has refreshModel causes
  assertions after test finishes (async leakage). GavinJoyce found a fix in
  `router.js` (using `oldHandlerInfo.serialize()`) but it was never merged upstream.

#### #20442 — replaceWith with empty/undefined query params

- **Branch:** `test/20442`
- **Author:** (cherry-picked cleanly)
- **Test added to:** `replaceWith_test.js`
- **Bug:** `this.routerService.replaceWith('route', undefined)` throws, while
  `this.routerService.replaceWith('route', {})` works fine.

---

### STILL FAILING — Rendering / Glimmer

#### #20630 — `{{on}}` modifier broken on true->false->true toggle

- **Branch:** `test/20630`
- **Test added to:** `packages/@ember/-internals/glimmer/tests/integration/modifiers/on-test.js`
- **Bug:** When an `{{on}}` modifier is conditionally rendered with `{{#if}}`,
  removing and re-adding it doesn't properly re-attach the event listener.

#### #18167 — Forwarded element modifiers ignore specified order

- **Branch:** `test/18167`
- **Test added to:** `angle-bracket-invocation-test.js`
- **Bug:** When using `...attributes` to forward modifiers, the modifiers always run
  before the component's own modifiers, regardless of where `...attributes` appears
  in the template.

#### #20612 — Chained redirection fires model hooks incorrectly

- **Branch:** `test/20612`
- **Author:** David Taylor
- **Test added to:** `events_test.js`
- **Bug:** When chaining redirections (1->2->3) via `routeWillChange`, the intermediate
  route's model hook fires for the wrong route (fires for route 2 twice instead of
  just route 3).

---

### NOT YET TESTED

#### #16716 — Model cleared after aborting transition in afterModel

- **Branch:** `test/16716`
- **Author:** Bujorel Tecu <btecu@vikus.com>
- **Test added to:** `decoupled_basic_test.js`
- **Bug:** After calling `transition.abort()` in `afterModel` and doing
  `intermediateTransitionTo`, `this.modelFor('users')` returns null.
- **Test written but not yet built/run.**

#### #15050 — Sticky QP in engine with loading template

- **Branch:** `test/15050`
- **Author:** Spencer Price <spencer516@gmail.com>
- **Test added to:** `engine-test.js`
- **Bug:** QPs lose stickiness when navigating between routes in a routable engine
  that uses a loading template.
- **Test written but has timing issue (resolveLoading called before assigned).**

---

### SKIPPED

#### #20830 — lookupComponentPair resolver tests

- **Reason:** Tests use a 3-argument signature `lookupComponentPair(null, null, {component, layout})`
  but the actual function only takes 2 arguments `(owner, name)`. Tests would never pass.

---

## Root Cause Clusters

### Query Params (7 PRs)

PRs #18579, #15832, #17451, #17452, #17831, #20442, #15050 all stem from issues
in the query param handling code. The core problems are:

1. **refreshModel detection** — parent routes refresh unnecessarily when child QPs change
2. **Cache key calculation** — wrong prefix used with resetNamespace
3. **Serialization** — `router.js` doesn't use `oldHandlerInfo.serialize()` properly
4. **Edge cases** — undefined/empty QP objects, sticky QPs in engines

A fix to `router.js` (the dependency) would address several of these at once.

### Modifier ordering/lifecycle (2 PRs)

PRs #20630 and #18167 are both about modifier lifecycle issues in the Glimmer VM.

### Router transition behavior (1 PR)

PR #20612 is about `routeWillChange` event handling during chained transitions.
