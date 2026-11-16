#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import dns from 'node:dns/promises';
import net from 'node:net';

// Константы по умолчанию
const DEFAULT_REQUESTS_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 60_000; // 60 секунд на один запрос
const PREFLIGHT_TIMEOUT_MS = 10_000; // 10 секунд на проверку доступности URL
const LARGE_FILE_WARNING_BYTES = 100 * 1024 * 1024; // Порог предупреждения: 100 MiB

/**
 * Форматирование байтов в человекочитаемый вид (MiB / KiB / B)
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Форматирование миллисекунд в с / мс
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Строгая синтаксическая проверка строки URL
 */
function validateUrlSyntax(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('URL не может быть пустым.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error('Некорректный формат URL. Пример правильного адреса: https://example.com/file.zip');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Неподдерживаемый протокол "${parsedUrl.protocol}". Используйте http:// или https://`);
  }

  const host = parsedUrl.hostname;
  if (!host) {
    throw new Error('В URL отсутствует имя хоста (домен или IP-адрес).');
  }

  // Если это не IP-адрес и не localhost, проверяем наличие нормальной доменной зоны (точки)
  const isIp = net.isIP(host) !== 0;
  const isLocalhost = host === 'localhost';
  if (!isIp && !isLocalhost && (!host.includes('.') || host.startsWith('.') || host.endsWith('.'))) {
    throw new Error(`Некорректное доменное имя "${host}".`);
  }

  return parsedUrl;
}

/**
 * Предварительная проверка в сети (DNS + доступность ресурса по HTTP)
 * Выполняется 1 раз ПЕРЕД запуском цикла из 10 запросов
 */
async function preflightCheckUrl(parsedUrl, maxBytes) {
  process.stdout.write(`🔍 Проверка доступности ресурса (${parsedUrl.hostname})... `);

  // 1. Проверка DNS (существует ли вообще такой домен)
  if (net.isIP(parsedUrl.hostname) === 0) {
    try {
      await dns.lookup(parsedUrl.hostname);
    } catch {
      console.log('❌');
      throw new Error(
        `Не удалось найти сервер "${parsedUrl.hostname}" (DNS lookup failed). Проверьте правильность написания домена и подключение к интернету.`
      );
    }
  }

  // 2. Проверка HTTP-ответа (HEAD запрос, с фоллбэком на GET при 405/403/501)
  try {
    let response = await fetch(parsedUrl.toString(), {
      method: 'HEAD',
      headers: {
        'User-Agent': 'NodeJS-Sequential-Benchmark/1.0',
        'Accept-Encoding': 'identity',
      },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      redirect: 'follow',
    });

    // Некоторые серверы блокируют метод HEAD (возвращают 405 Method Not Allowed и т.п.)
    // В таком случае пробуем обычный GET и сразу закрываем стрим после получения заголовков
    if (!response.ok && [400, 403, 405, 501].includes(response.status)) {
      const abortController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
      const signal = AbortSignal.any
        ? AbortSignal.any([abortController.signal, timeoutSignal])
        : timeoutSignal;

      response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'NodeJS-Sequential-Benchmark/1.0',
          'Accept-Encoding': 'identity',
          Range: 'bytes=0-0',
        },
        signal,
        redirect: 'follow',
      });

      if (response.body) {
        await response.body.cancel().catch(() => {});
      }
      abortController.abort();
    }

    if (!response.ok) {
      console.log('❌');
      throw new Error(
        `Сервер ответил ошибкой: HTTP ${response.status} (${response.statusText}). Скачивание отменено.`
      );
    }

    const contentLengthHeader = response.headers.get('content-length');
    const contentRangeHeader = response.headers.get('content-range'); // например: bytes 0-0/104857600
    const contentType = response.headers.get('content-type') || 'не указан';

    let fileSize = contentLengthHeader ? Number(contentLengthHeader) : null;
    if (contentRangeHeader && contentRangeHeader.includes('/')) {
      const totalFromRange = Number(contentRangeHeader.split('/')[1]);
      if (!Number.isNaN(totalFromRange) && totalFromRange > 0) {
        fileSize = totalFromRange;
      }
    }

    console.log('✅ Доступен!');
    console.log(
      `📄 Информация о ресурсе: Тип: ${contentType} | Размер: ${fileSize ? formatBytes(fileSize) : 'неизвестен (chunked)'}`
    );

    // Предупреждение о слишком большом файле, если не задан лимит
    if (fileSize && fileSize > LARGE_FILE_WARNING_BYTES && maxBytes === null) {
      console.warn(
        `\n⚠️  ВНИМАНИЕ: Размер файла составляет ${formatBytes(fileSize)}.\n` +
          `   Полное скачивание файла 10 раз подряд (${formatBytes(fileSize * 10)}) может занять много времени и трафика.\n` +
          `   💡 Совет: вы можете ограничить объем одного запроса флагом --max-size=100 (в MiB).\n`
      );
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.log('❌');
      throw new Error(
        `Сервер не ответил в течение ${PREFLIGHT_TIMEOUT_MS / 1000} секунд при предварительной проверке.`
      );
    }
    // Если это уже наша красивая ошибка — пробрасываем дальше
    if (err.message.startsWith('Сервер ответил ошибкой')) {
      throw err;
    }
    console.log('❌');
    throw new Error(`Не удалось подключиться к "${parsedUrl.toString()}": ${err.message}`);
  }
}

/**
 * Разбор и валидация аргументов командной строки
 */
function getCliOptions() {
  try {
    const { values, positionals } = parseArgs({
      options: {
        'max-size': { type: 'string', short: 'm' },
        requests: { type: 'string', short: 'n' },
        timeout: { type: 'string', short: 't' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });

    if (values.help || positionals.length === 0) {
      printUsage();
      process.exit(values.help ? 0 : 1);
    }

    // 1. Валидация синтаксиса URL
    let parsedUrl;
    try {
      parsedUrl = validateUrlSyntax(positionals[0]);
    } catch (err) {
      console.error(`❌ Ошибка валидации URL: ${err.message}`);
      process.exit(1);
    }

    // Лимит размера в мегабайтах (MiB). По умолчанию null (без лимита)
    let maxSizeMiB = null;
    if (values['max-size'] !== undefined) {
      maxSizeMiB = Number(values['max-size']);
      if (Number.isNaN(maxSizeMiB) || maxSizeMiB <= 0) {
        console.error('❌ Ошибка: Параметр --max-size должен быть положительным числом (в МБ).');
        process.exit(1);
      }
    }

    const requestsCount = values.requests ? Number(values.requests) : DEFAULT_REQUESTS_COUNT;
    if (!Number.isInteger(requestsCount) || requestsCount <= 0) {
      console.error('❌ Ошибка: Количество запросов (-n) должно быть целым положительным числом.');
      process.exit(1);
    }

    const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : DEFAULT_TIMEOUT_MS;
    if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
      console.error('❌ Ошибка: Таймаут (-t) должен быть положительным числом (в секундах).');
      process.exit(1);
    }

    return {
      parsedUrl,
      url: parsedUrl.toString(),
      maxBytes: maxSizeMiB ? Math.floor(maxSizeMiB * 1024 * 1024) : null,
      maxSizeMiB,
      requestsCount,
      timeoutMs,
    };
  } catch (err) {
    console.error(`❌ Ошибка разбора аргументов: ${err.message}`);
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
Использование:
  node index.js <URL> [опции]

Опции:
  -m, --max-size <MB>   Ограничить объем скачивания одного запроса (в MiB). По умолчанию: без лимита
  -n, --requests <num>  Количество последовательных запросов (по умолчанию: 10)
  -t, --timeout <sec>   Таймаут на один запрос в секундах (по умолчанию: 60)
  -h, --help            Показать эту справку

Примеры:
  node index.js https://speed.hetzner.de/100MB.bin
  node index.js https://speed.hetzner.de/1GB.bin --max-size=50
  `);
}

/**
 * Выполнение одного запроса с потоковым чтением тела ответа
 */
async function performSingleRequest(url, { maxBytes, timeoutMs, globalAbortSignal }) {
  const startTime = performance.now();

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([globalAbortSignal, timeoutSignal])
    : timeoutSignal;

  const headers = {
    'User-Agent': 'NodeJS-Sequential-Benchmark/1.0',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    'Accept-Encoding': 'identity',
  };

  if (maxBytes !== null) {
    headers['Range'] = `bytes=0-${maxBytes - 1}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: combinedSignal,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP статус ${response.status} (${response.statusText})`);
  }

  if (!response.body) {
    throw new Error('Сервер вернул пустое тело ответа (нет ReadableStream)');
  }

  const reader = response.body.getReader();
  let downloadedBytes = 0;
  let limitReached = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        downloadedBytes += value.byteLength;

        if (maxBytes !== null && downloadedBytes >= maxBytes) {
          downloadedBytes = maxBytes;
          limitReached = true;
          await reader.cancel('Достигнут лимит max-size');
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const durationMs = performance.now() - startTime;

  return {
    bytes: downloadedBytes,
    durationMs,
    status: response.status,
    limitReached,
  };
}

/**
 * Главная функция
 */
async function main() {
  const options = getCliOptions();

  console.log('====================================================');
  console.log(`🎯 Цель:               ${options.url}`);
  console.log(`🔄 Количество попыток: ${options.requestsCount} (последовательно)`);
  console.log(
    `📦 Лимит на запрос:    ${options.maxSizeMiB ? `${options.maxSizeMiB} MiB` : 'Нет (скачивание целиком)'}`
  );
  console.log(`⏱️  Таймаут запроса:    ${options.timeoutMs / 1000} сек.`);
  console.log('====================================================');

  // Предварительная проверка URL в сети ПЕРЕД запуском цикла
  try {
    await preflightCheckUrl(options.parsedUrl, options.maxBytes);
  } catch (err) {
    console.error(`\n❌ Предварительная проверка не пройдена:\n   ${err.message}`);
    process.exit(1);
  }

  console.log(''); // пустая строка перед списком запросов

  const globalAbortController = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (!interrupted) {
      interrupted = true;
      console.log('\n🛑 Получен сигнал прерывания (SIGINT). Завершаем текущий запрос и подводим итоги...');
      globalAbortController.abort(new Error('Прервано пользователем'));
    }
  });

  const results = [];
  let failedCount = 0;

  for (let i = 1; i <= options.requestsCount; i++) {
    if (interrupted) break;

    const prefix = `[Запрос ${String(i).padStart(2, ' ')}/${options.requestsCount}]`;
    process.stdout.write(`${prefix} Скачивание... `);

    try {
      const result = await performSingleRequest(options.url, {
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
        globalAbortSignal: globalAbortController.signal,
      });

      results.push(result);

      const speedMiBs = result.bytes / (1024 * 1024) / (result.durationMs / 1000);
      const limitNote = result.limitReached || result.status === 206 ? ' [лимит достигнут]' : '';

      console.log(
        `✅ HTTP ${result.status} | ${formatBytes(result.bytes)} за ${formatDuration(result.durationMs)} ` +
          `(${speedMiBs.toFixed(2)} MiB/s)${limitNote}`
      );
    } catch (err) {
      if (interrupted) {
        console.log('⏹️ Прервано пользователем.');
        break;
      }
      failedCount++;
      const isTimeout = err.name === 'TimeoutError';
      const errorMsg = isTimeout ? `Превышен таймаут (${options.timeoutMs / 1000} с)` : err.message;
      console.log(`❌ Ошибка: ${errorMsg}`);
    }
  }

  // Вывод итоговой статистики
  console.log('\n====================================================');
  console.log('📊 ИТОГОВАЯ СТАТИСТИКА');
  console.log('====================================================');

  if (results.length === 0) {
    console.log('Ни один запрос не завершился успешно. Расчет статистики невозможен.');
    process.exit(1);
  }

  const totalBytes = results.reduce((acc, r) => acc + r.bytes, 0);
  const totalDurationMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  const avgDurationMs = totalDurationMs / results.length;
  const totalSeconds = totalDurationMs / 1000;

  const speedMiBps = totalBytes / (1024 * 1024) / totalSeconds;
  const speedMBps = totalBytes / 1_000_000 / totalSeconds;
  const speedMbps = (totalBytes * 8) / 1_000_000 / totalSeconds;

  console.log(`Успешных запросов:       ${results.length} из ${options.requestsCount} (ошибок: ${failedCount})`);
  console.log(`Общий объём данных:      ${formatBytes(totalBytes)} (${totalBytes.toLocaleString('ru-RU')} байт)`);
  console.log(`Общее время скачивания:  ${formatDuration(totalDurationMs)} (${totalDurationMs.toFixed(2)} ms)`);
  console.log(`Среднее время запроса:   ${formatDuration(avgDurationMs)} (${avgDurationMs.toFixed(2)} ms)`);
  console.log('----------------------------------------------------');
  console.log(`🚀 Средняя скорость скачивания:`);
  console.log(`   • ${speedMiBps.toFixed(2)} MiB/s (мебибайт/сек, 1 MiB = 1024² байт)`);
  console.log(`   • ${speedMBps.toFixed(2)} MB/s  (мегабайт/сек, 1 MB  = 10⁶ байт)`);
  console.log(`   • ${speedMbps.toFixed(2)} Mbps  (мегабит/сек,  1 Mb  = 10⁶ бит)`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});