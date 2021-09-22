import apmNode from 'elastic-apm-node';
import { isEmpty, times } from 'lodash';
import config from '../config/default';
import { ConfigTransaction } from './typings';
import { getWorkerEnvironment } from './worker_environment';

export function generateApmData() {
  const { instanceId, lookbackStartTime } = getWorkerEnvironment();
  const apm = apmNode.start({
    serviceNodeName: `instance-${instanceId}`,
    serviceName: 'My New Service',
    metricsInterval: '10s',
    stackTraceLimit: 1,
    captureSpanStackTraces: false,
    maxQueueSize: 10000000,
  });

  const lookbackDurationInMillis = config.lookbackDurationInMinutes * 1000 * 60;

  config.transactions.forEach((transaction) => {
    const throughputPerInstance =
      transaction.transactionRateTpm / config.instanceCount;

    const totalRequestCount =
      throughputPerInstance * config.lookbackDurationInMinutes;
    const msPerRequest = lookbackDurationInMillis / totalRequestCount;

    // generate historical data
    times(totalRequestCount).reduce<Promise<unknown>>(async (p, i) => {
      const startTime = lookbackStartTime + msPerRequest * i;
      await p;
      await sleep(5);
      createTransaction({ apm, transaction, startTime });
    }, Promise.resolve());

    // generate concurrent data
    setInterval(() => {
      createTransaction({ apm, transaction, startTime: Date.now() });
    }, (60 / throughputPerInstance) * 1000);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTransaction({
  apm,
  transaction,
  startTime,
}: {
  apm: apmNode.Agent;
  transaction: ConfigTransaction;
  startTime: number;
}) {
  const t = apm.startTransaction(transaction.name, 'my-type', {
    startTime,
  });

  if (!t) {
    return;
  }

  const errorTimestamp = startTime + transaction.duration / 2;
  apm.captureError(new Error('Boom!'), { timestamp: errorTimestamp });

  const isFailureOutcome = Math.random() <= transaction.failedTransactionRate;
  const outcome = isFailureOutcome ? 'failure' : 'success';
  t.setOutcome(outcome);

  //@ts-expect-error
  const s = t.startSpan('My span', 'app', 'foobar', { startTime });
  s?.setOutcome(outcome);
  s?.end(startTime + transaction.duration);

  const postgresSpans = transaction.spans?.filter(
    (span) => span.type === 'postgres'
  );
  if (!isEmpty(postgresSpans)) {
    postgresSpans?.forEach((span) => {
      createPostgresSpan({ startTime, duration: span.duration, outcome, t });
    });
  }

  const elasticsearchSpans = transaction.spans?.filter(
    (span) => span.type === 'elasticsearch'
  );
  if (!isEmpty(elasticsearchSpans)) {
    elasticsearchSpans?.forEach((span) => {
      createElasticsearchSpan({
        startTime,
        duration: span.duration,
        outcome,
        t,
      });
    });
  }

  t.end(outcome, startTime + transaction.duration);
}

function createElasticsearchSpan({
  startTime,
  duration,
  t,
}: {
  startTime: number;
  duration: number;
  outcome: string;
  t: apmNode.Transaction;
}) {
  //@ts-expect-error
  const span = t.startSpan('Elasticsearch: POST _bulk', 'db', 'elasticsearch', {
    startTime,
  });

  if (!span) {
    return;
  }

  //@ts-expect-error
  span.setDestinationContext({
    address: 'address.to.es',
    port: 9243,
    service: {
      name: 'elasticsearch',
      resource: 'elasticsearch',
      type: 'db',
    },
  });

  span.end(startTime + duration);
}

function createPostgresSpan({
  startTime,
  duration,
  t,
}: {
  startTime: number;
  duration: number;
  outcome: string;
  t: apmNode.Transaction;
}) {
  //@ts-expect-error
  const span = t.startSpan('SELECT FROM orders', 'db', 'postgresql', {
    startTime,
  });

  if (!span) {
    return;
  }

  //@ts-expect-error
  span.setDestinationContext({
    address: 'db-postgresql',
    port: 5432,
    service: {
      name: 'postgresql',
      resource: 'postgresql',
      type: 'db',
    },
  });

  span.end(startTime + duration);
}
