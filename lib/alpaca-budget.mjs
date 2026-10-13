/** Shared portal/Modal Alpaca minute budget. Requires AWS CLI credentials with
 * dynamodb:UpdateItem on nwf_rate_budget; fails closed if unavailable.
 * https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-item.html
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
export const ALPACA_CALLS_PER_MINUTE = 190;

/** Reserve calls atomically using the same bucket as the Modal pipelines. */
export async function acquireAlpacaBudget({ calls = 1, now = Date.now(), updateItem = cliUpdateItem } = {}) {
  if (!Number.isInteger(calls) || calls < 1 || calls > ALPACA_CALLS_PER_MINUTE) {
    throw new Error('Alpaca budget calls must be an integer between 1 and 190');
  }
  const minute = new Date(now).toISOString().slice(0, 16);
  await updateItem({
    TableName: process.env.ALPACA_BUDGET_TABLE || 'nwf_rate_budget',
    Key: { bucket: { S: `alpaca#${minute}` } },
    UpdateExpression: 'ADD calls :n SET expires_at = if_not_exists(expires_at, :ttl)',
    ConditionExpression: 'attribute_not_exists(calls) OR calls <= :cap',
    ExpressionAttributeValues: {
      ':n': { N: String(calls) },
      ':cap': { N: String(ALPACA_CALLS_PER_MINUTE - calls) },
      ':ttl': { N: String(Math.floor(now / 1000) + 120) },
    },
  });
}

async function cliUpdateItem(input) {
  try {
    await runFile('aws', ['dynamodb', 'update-item', '--cli-input-json', JSON.stringify(input), '--no-cli-pager'], {
      timeout: 15_000, maxBuffer: 64 * 1024,
    });
  } catch (error) {
    // Never expose CLI stderr or inherited credential material.
    const exhausted = String(error?.stderr ?? '').includes('ConditionalCheckFailedException');
    throw new Error(exhausted ? 'Alpaca shared minute budget exhausted' : 'Alpaca shared budget unavailable');
  }
}
