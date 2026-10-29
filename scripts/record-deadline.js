'use strict';

const DEFAULT_RECORD_DEADLINE_MS = 20 * 60_000;

async function withRecordDeadline(label, work, deadlineMs = DEFAULT_RECORD_DEADLINE_MS) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label}: exceeded ${Math.ceil(deadlineMs / 60_000)} minute record deadline`));
    }, deadlineMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {DEFAULT_RECORD_DEADLINE_MS, withRecordDeadline};
