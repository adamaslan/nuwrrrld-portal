/** Shared portal/Modal Alpaca minute budget. Requires AWS CLI credentials with
 * dynamodb:UpdateItem on nwf_rate_budget; fails closed if unavailable.
 * https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-item.html
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
const runFile = promisify(execFile);
export const ALPACA_CALLS_PER_MINUTE = 190;
const MAX_BUDGET_RETRIES = 3;
const MINUTE_MS = 60_000;

/** Reserve calls atomically using the same bucket as the Modal pipelines. */
export async function acquireAlpacaBudget({ calls = 1, now = Date.now(), updateItem = cliUpdateItem,
  wait = sleep, clock = Date.now } = {}) {
  if (!Number.isInteger(calls) || calls < 1 || calls > ALPACA_CALLS_PER_MINUTE) {
    throw new Error('Alpaca budget calls must be an integer between 1 and 190');
  }
  let reservationTime = now;
  for (let attempt = 0; ; attempt++) {
    const minute = new Date(reservationTime).toISOString().slice(0, 16);
    try {
      await updateItem({
        TableName: process.env.ALPACA_BUDGET_TABLE || 'nwf_rate_budget',
        Key: { bucket: { S: `alpaca#${minute}` } },
        UpdateExpression: 'ADD calls :n SET expires_at = if_not_exists(expires_at, :ttl)',
        ConditionExpression: 'attribute_not_exists(calls) OR calls <= :cap',
        ExpressionAttributeValues: {
          ':n': { N: String(calls) },
          ':cap': { N: String(ALPACA_CALLS_PER_MINUTE - calls) },
          ':ttl': { N: String(Math.floor(reservationTime / 1000) + 120) },
        },
      });
      return;
    } catch (error) {
      // Only an atomic capacity rejection is safe to wait out. DynamoDB and
      // credential failures still fail closed before any vendor request.
      if (error?.name !== 'ConditionalCheckFailedException' || attempt >= MAX_BUDGET_RETRIES) throw error;
      const currentTime = clock();
      await wait(MINUTE_MS - (currentTime % MINUTE_MS));
      reservationTime = clock();
    }
  }
}

async function cliUpdateItem(input) {
  try {
    await runFile('aws', ['dynamodb', 'update-item', '--cli-input-json', JSON.stringify(input), '--no-cli-pager'], {
      timeout: 15_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    // AWS CLI diagnostics can contain request details. Keep only a small,
    // allow-listed category so workflow logs are actionable without echoing
    // stderr or inherited credential material.
    const category = classifyBudgetCliFailure(error);
    const exhausted = category === 'capacity_exhausted';
    const failure = new Error(exhausted
      ? 'Alpaca shared minute budget exhausted'
      : `Alpaca shared budget unavailable (${category})`);
    if (exhausted) failure.name = 'ConditionalCheckFailedException';
    throw failure;
  }
}

/** Return a safe diagnostic category for an AWS CLI failure. */
export function classifyBudgetCliFailure(error) {
  const stderr = String(error?.stderr ?? '');
  if (/ConditionalCheckFailedException/.test(stderr)) return 'capacity_exhausted';
  if (error?.code === 'ENOENT') return 'aws_cli_missing';
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKETTIMEDOUT') return 'request_timeout';
  if (/ExpiredToken|InvalidClientTokenId|UnrecognizedClientException/.test(stderr)) return 'credentials_invalid';
  if (/Unable to locate credentials|NoCredentialsError/.test(stderr)) return 'credentials_missing';
  if (/AccessDenied|AccessDeniedException|not authorized to perform/i.test(stderr)) return 'access_denied';
  if (/ResourceNotFoundException|Requested resource not found/i.test(stderr)) return 'table_missing';
  if (/ThrottlingException|ProvisionedThroughputExceededException/.test(stderr)) return 'dynamodb_throttled';
  if (/Could not connect to the endpoint URL|ENOTFOUND|ECONNRESET|ECONNREFUSED/.test(stderr)) return 'network_unavailable';
  return 'unknown';
}
