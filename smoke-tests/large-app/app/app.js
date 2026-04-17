import Application from 'ember-strict-application-resolver';

/**
 * Broad globs pull every generated artifact into the bundle so the build-time
 * fixture exercises the full resolver + babel pipeline regardless of router
 * reachability. This app is a build-time-only fixture and does not need to
 * navigate correctly at runtime.
 */
export default class App extends Application {
  modules = {
    ...import.meta.glob('./router.*', { eager: true }),
    ...import.meta.glob('./templates/application.*', { eager: true }),
    ...import.meta.glob('./components/generated/**/*', { eager: true }),
    ...import.meta.glob('./controllers/generated/**/*', { eager: true }),
    ...import.meta.glob('./helpers/generated/**/*', { eager: true }),
    ...import.meta.glob('./modifiers/generated/**/*', { eager: true }),
    ...import.meta.glob('./routes/generated/**/*', { eager: true }),
    ...import.meta.glob('./services/generated/**/*', { eager: true }),
    ...import.meta.glob('./utils/generated/**/*', { eager: true }),
  };
}
