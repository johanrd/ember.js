import type { Route } from '../index';
import type { Dict } from '../lib/core';
import { Promise } from 'rsvp';
import type RouteInfo from '../lib/route-info';
import { assertAbort, createHandler, shouldNotHappen, trigger, TestRouter } from './test_helpers';

function map(router: TestRouter) {
  router.map(function (match) {
    match('/index').to('index');
    match('/foo').to('foo', function (match) {
      match('/').to('fooIndex');
      match('/bar').to('fooBar');
    });
  });
}

// Intentionally use QUnit.module instead of module from test_helpers
// so that we avoid using Backburner to handle the async portions of
// the test suite
let routes: Dict<Route>;
let router: TestRouter;
QUnit.module('Async Get Handler', {
  beforeEach: function () {
    routes = {};
  },
});

QUnit.test('can transition to lazily-resolved routes', function (assert) {
  let done = assert.async();

  class LazyRouter extends TestRouter {
    getRoute(name: string) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(routes[name] || (routes[name] = createHandler('empty')));
        }, 1);
      });
    }
  }

  router = new LazyRouter();
  map(router);

  let fooCalled = false;
  let fooBarCalled = false;

  routes['foo'] = createHandler('foo', {
    model() {
      fooCalled = true;
    },
  });
  routes['fooBar'] = createHandler('fooBar', {
    model: function () {
      fooBarCalled = true;
    },
  });

  router.transitionTo('/foo/bar').then(function () {
    assert.ok(fooCalled, 'foo is called before transition ends');
    assert.ok(fooBarCalled, 'fooBar is called before transition ends');
    done();
  });

  assert.notOk(fooCalled, 'foo is not called synchronously');
  assert.notOk(fooBarCalled, 'fooBar is not called synchronously');
});

QUnit.test('calls hooks of lazily-resolved routes in order', function (assert) {
  let done = assert.async();
  let operations: string[] = [];

  class LazyRouter extends TestRouter {
    getRoute(name: string) {
      operations.push('get handler ' + name);
      return new Promise(function (resolve) {
        let timeoutLength = name === 'foo' ? 100 : 1;
        setTimeout(function () {
          operations.push('resolved ' + name);
          resolve(routes[name] || (routes[name] = createHandler('empty')));
        }, timeoutLength);
      });
    }
  }

  router = new LazyRouter();
  map(router);

  routes['foo'] = createHandler('foo', {
    model: function () {
      operations.push('model foo');
    },
  });
  routes['fooBar'] = createHandler('fooBar', {
    model: function () {
      operations.push('model fooBar');
    },
  });

  router.transitionTo('/foo/bar').then(function () {
    assert.deepEqual(
      operations,
      [
        'get handler foo',
        'get handler fooBar',
        'resolved fooBar',
        'resolved foo',
        'model foo',
        'model fooBar',
      ],
      'order of operations is correct'
    );
    done();
  }, null);
});

QUnit.test(
  'a query param transition started while a lazily-resolved route is loading does not throw',
  async function (assert) {
    assert.expect(3);

    let pendingRoutes: (() => void)[] = [];
    let urls: string[] = [];

    function consumeAllFinalQueryParams(params: Dict<unknown>, finalParams: Dict<unknown>[]) {
      for (let key in params) {
        let value = params[key];
        delete params[key];
        finalParams.push({ key, value });
      }
      return true;
    }

    class LazyRouter extends TestRouter {
      getRoute(name: string) {
        let route =
          routes[name] ||
          (routes[name] = createHandler(name, {
            events: { finalizeQueryParamChange: consumeAllFinalQueryParams },
          }));

        // `child` stands in for a route in a bundle that has not been
        // downloaded yet: `getRoute` hands back a promise, so its routeInfo
        // has no `route` until that promise settles.
        if (name === 'child') {
          return new Promise<Route>((resolve) => pendingRoutes.push(() => resolve(route)));
        }

        return route;
      }
      triggerEvent(
        routeInfos: RouteInfo<Route>[],
        ignoreFailure: boolean,
        name: string,
        args: any[]
      ) {
        trigger(routeInfos, ignoreFailure, name, ...args);
      }
      updateURL(url: string) {
        urls.push(url);
      }
      replaceURL(url: string) {
        urls.push(url);
      }
    }

    router = new LazyRouter();
    router.map(function (match) {
      match('/parent').to('parent', function (match) {
        match('/child/:id').to('child');
      });
    });

    async function resolvePendingRoutes() {
      for (let i = 0; i < 4; i++) {
        pendingRoutes.splice(0).forEach((resolve) => resolve());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    let initial = router.transitionTo('/parent/child/1');
    await resolvePendingRoutes();
    await initial;

    // Enter the same route with a new dynamic segment and leave the transition
    // in flight while `child` loads.
    let inFlight = router.transitionTo('/parent/child/2');

    // While that is still loading, only a query param changes. This reads
    // `routeInfo.route` off the in-flight transition's state, where the lazily
    // resolved routes have no `route` yet.
    let queryParams = router.transitionTo({ queryParams: { sort: 'asc' } });

    await resolvePendingRoutes();

    await queryParams;
    assert.ok(true, 'the query param transition resolves rather than throwing');

    await inFlight.then(shouldNotHappen(assert), assertAbort(assert));

    assert.deepEqual(
      urls,
      ['/parent/child/1', '/parent/child/2?sort=asc'],
      'the query param is reflected in the URL'
    );
  }
);
