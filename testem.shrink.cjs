module.exports = {
  test_page: 'index.html/?filter=each%20over%20an%20array%20that%20shrinks%20mid-render',
  cwd: 'dist', timeout: 540, parallel: 1, disable_watching: true,
  launch_in_ci: ['Chrome'], browser_start_timeout: 120, browser_disconnect_timeout: 1200,
  browser_args: { Chrome: { ci: ['--headless','--disable-dev-shm-usage','--mute-audio','--remote-debugging-port=0'] } },
};
