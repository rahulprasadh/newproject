// Trains the next-move forecaster and runs the pattern lab off the page's main thread.
// In: {id, bars, opts (engine), popts (walkForward, or null to skip it), lab (true to run the lab)}.
// Out: {id, wf, error, lab, labError}.
importScripts('candles.js', 'engine.js', 'predict.js', 'patternlab.js');

self.onmessage = ev => {
  const { id, bars, opts, popts, lab } = ev.data;
  const out = { id, wf: null, lab: null };
  let E;
  try {
    E = SMC.run(bars, opts);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
    return;
  }
  if (popts) {
    try {
      out.wf = SMCPredict.walkForward(E, popts);
      delete out.wf.rows;   // forecast() never reads them and they are the bulk of the payload
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
  }
  if (lab) {
    try {
      out.lab = SMCPatternLab.study(E, { spread: (opts && opts.spread) || 0 });
    } catch (err) {
      out.labError = String((err && err.message) || err);
    }
  }
  self.postMessage(out);
};
