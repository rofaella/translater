// Web Worker: запускает модели перевода, чтобы страница не зависала.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true; // файлы моделей хранятся в Cache API ("transformers-cache")

const loaded = new Map(); // modelId -> pipeline (только то, что нужно для текущего перевода)
let queue = Promise.resolve();

function post(msg) {
  self.postMessage(msg);
}

function errText(e) {
  return e && e.message ? e.message : String(e);
}

// Следит за скачиванием файлов одной модели и отдаёт долю 0..1 (не уменьшается).
function makeTracker(emit) {
  const files = new Map();
  let best = 0;
  return function (p) {
    if (!p) return;
    if (p.status === 'ready') {
      emit('', 1);
      return;
    }
    if (!p.file) return;
    if (p.status === 'progress') {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    } else if (p.status === 'done') {
      const f = files.get(p.file);
      if (f) f.loaded = f.total;
    }
    let l = 0;
    let t = 0;
    for (const f of files.values()) {
      l += f.loaded;
      t += f.total;
    }
    const frac = t > 0 ? l / t : 0;
    if (frac > best) best = frac;
    emit(p.file, best);
  };
}

async function disposePipe(pipe) {
  try {
    if (pipe && typeof pipe.dispose === 'function') await pipe.dispose();
    else if (pipe && pipe.model && typeof pipe.model.dispose === 'function') await pipe.model.dispose();
  } catch (_) {
    /* не страшно */
  }
}

// Выгружаем из оперативной памяти всё лишнее. Файлы остаются в кэше браузера.
async function keepOnly(ids) {
  const keep = new Set(ids);
  for (const [id, pipe] of Array.from(loaded.entries())) {
    if (!keep.has(id)) {
      await disposePipe(pipe);
      loaded.delete(id);
    }
  }
}

async function getPipe(modelId, index, count) {
  if (loaded.has(modelId)) return loaded.get(modelId);
  const track = makeTracker(function (file, fraction) {
    post({ type: 'progress', phase: 'load', model: modelId, modelIndex: index, modelCount: count, file: file, fraction: fraction });
  });
  const pipe = await pipeline('translation', modelId, { quantized: true, progress_callback: track });
  loaded.set(modelId, pipe);
  return pipe;
}

// ---- Разбиение текста на фрагменты (модели держат до ~512 токенов) ----

function chunkParagraph(p, maxLen) {
  maxLen = maxLen || 300;
  const sentences = (p.match(/[^.!?…]+(?:[.!?…]+["'»”)]*|$)\s*/g) || [p]).map(function (s) { return s.trim(); }).filter(Boolean);
  const pieces = [];
  for (const s of sentences) {
    if (s.length <= 450) {
      pieces.push(s);
      continue;
    }
    let cur = '';
    for (const w of s.split(/\s+/)) {
      if (cur && (cur + ' ' + w).length > 400) {
        pieces.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) pieces.push(cur);
  }
  const chunks = [];
  let cur = '';
  for (const s of pieces) {
    if (cur && cur.length + 1 + s.length > maxLen) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function assemble(paras, items) {
  return paras
    .map(function (chunks, pi) {
      if (!chunks) return '';
      return items
        .filter(function (it) { return it.pi === pi; })
        .map(function (it) { return it.text; })
        .join(' ');
    })
    .join('\n');
}

// ---- Обработчики сообщений ----

async function handleDownload(msg) {
  await keepOnly([]);
  const ids = msg.models;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    post({ type: 'progress', phase: 'download', model: id, modelIndex: i, modelCount: ids.length, file: '', fraction: 0 });
    const track = makeTracker(function (file, fraction) {
      post({ type: 'progress', phase: 'download', model: id, modelIndex: i, modelCount: ids.length, file: file, fraction: fraction });
    });
    const pipe = await pipeline('translation', id, { quantized: true, progress_callback: track });
    await disposePipe(pipe); // файлы уже в кэше, память освобождаем
    post({ type: 'model-done', model: id, index: i + 1, count: ids.length });
  }
  post({ type: 'download-done' });
}

async function handleTranslate(msg) {
  const t0 = Date.now();
  const id = msg.id;
  const route = msg.route;
  const paras = msg.text.split(/\r?\n/).map(function (p) {
    return p.trim() ? chunkParagraph(p.trim()) : null;
  });
  const items = [];
  paras.forEach(function (chunks, pi) {
    if (chunks) chunks.forEach(function (c) { items.push({ pi: pi, text: c }); });
  });

  const modelIds = Array.from(new Set(route.map(function (s) { return s.model; })));
  await keepOnly(modelIds);

  let pivot = '';
  for (let s = 0; s < route.length; s++) {
    const step = route[s];
    const pipe = await getPipe(step.model, modelIds.indexOf(step.model), modelIds.length);
    const opts = { max_new_tokens: 256 };
    if (step.src_lang) {
      opts.src_lang = step.src_lang;
      opts.tgt_lang = step.tgt_lang;
    }
    for (let i = 0; i < items.length; i++) {
      post({ type: 'tprogress', id: id, step: s + 1, steps: route.length, done: i, total: items.length });
      const out = await pipe(items[i].text, opts);
      items[i].text = out[0].translation_text;
    }
    if (s < route.length - 1) pivot = assemble(paras, items);
  }

  post({ type: 'result', id: id, output: assemble(paras, items), pivot: pivot, ms: Date.now() - t0 });
}

self.onmessage = function (ev) {
  const msg = ev.data;
  queue = queue
    .then(function () {
      if (msg.type === 'download') return handleDownload(msg);
      if (msg.type === 'translate') return handleTranslate(msg);
    })
    .catch(function (e) {
      post({ type: 'error', id: msg.id, message: errText(e) });
    });
};
