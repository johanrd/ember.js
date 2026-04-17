import EmberRouter from '@embroider/router';
import config from 'large-app/config/environment';

export default class Router extends EmberRouter {
  location = config.locationType;
  rootURL = config.rootURL;
}

// Empty map: routes are pulled into the bundle via import.meta.glob in app.js,
// not via router.map, so that the build-time fixture stresses resolution
// without requiring runtime correctness.
Router.map(function () {});
