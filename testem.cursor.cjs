module.exports = {
  test_page: 'index.html/?filter=logOpcodeSlice%20cursor%20park',
  cwd: 'dist', timeout: 540, parallel: 1, disable_watching: true,
  launch_in_ci: ['Chrome'], browser_start_timeout: 120, browser_disconnect_timeout: 1200,
  browser_args: { Chrome: { ci: ['--headless','--disable-dev-shm-usage','--mute-audio','--remote-debugging-port=0'] } },
};
