import { Kafka, logLevel } from 'kafkajs';
import { config } from './config.js';

const TOPICS = {
  raw: 'txn.events.raw',
  scored: 'txn.fraud.scored',
  status: 'txn.status.updates',
  activity: 'user.activity'
};

let kafka = null;
let producer = null;
let consumer = null;

function initKafka() {
  if (!config.kafka.enabled) return null;
  kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    logLevel: logLevel.NOTHING
  });
  producer = kafka.producer();
  consumer = kafka.consumer({ groupId: 'sentinelpay-api' });
  return kafka;
}

async function publish(topic, key, payload) {
  if (!config.kafka.enabled) return false;
  if (!producer) initKafka();
  try {
    await producer.connect();
    await producer.send({
      topic,
      messages: [{ key: String(key ?? ''), value: JSON.stringify({ ...payload, published_at: new Date().toISOString() }) }]
    });
    return true;
  } catch (err) {
    console.error(`[kafka] publish failed on ${topic}:`, err.message);
    return false;
  }
}

export { TOPICS, publish, initKafka };
export function getProducer() { return producer; }
