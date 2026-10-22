// Trains the next-move forecaster off the page's main thread.
// In: {id, bars, opts (engine), popts (walkForward)}. Out: {id, wf} or {id, error}.
importScripts('engine.js', 'predict.js');

self.onmessage = ev => {
  const { id, bars, opts, popts } = ev.data;
  try {
    const E = SMC.run(bars, opts);
    const wf = SMCPredict.walkForward(E, popts);
    delete wf.rows;   // forecast() never reads them and they are the bulk of the payload
    self.postMessage({ id, wf });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
