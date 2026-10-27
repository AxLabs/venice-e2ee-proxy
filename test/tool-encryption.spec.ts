import { describe, expect, it } from 'vitest';
import {
  createVeniceE2EE,
  deriveAESKey,
  fromHex,
  generateKeypair,
  toHex,
  type E2EESession,
} from '@axlabs/venice-e2ee';

async function sessionPair(): Promise<{ session: E2EESession; modelPrivateKey: Uint8Array }> {
  const client = generateKeypair();
  const model = generateKeypair();
  const aesKey = await deriveAESKey(client.privateKey, model.pubKeyHex);
  return {
    modelPrivateKey: model.privateKey,
    session: {
      privateKey: client.privateKey,
      publicKey: client.publicKey,
      pubKeyHex: client.pubKeyHex,
      modelPubKeyHex: model.pubKeyHex,
      aesKey,
      modelId: 'e2ee-test',
      created: Date.now(),
    },
  };
}

async function decryptWire(cipherHex: string, modelPrivateKey: Uint8Array): Promise<string> {
  const raw = fromHex(cipherHex);
  const clientPubHex = toHex(raw.slice(0, 65));
  const iv = raw.slice(65, 77);
  const ciphertext = raw.slice(77);
  const aesKey = await deriveAESKey(modelPrivateKey, clientPubHex);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

describe('tool-result encryption', () => {
  it('encrypts tool-result content and keeps call metadata in the clear', async () => {
    const { session, modelPrivateKey } = await sessionPair();
    const e2ee = createVeniceE2EE({ apiKey: 'test', verifyAttestation: false });
    const secret = '22C and sunny';

    const { encryptedMessages } = await e2ee.encrypt(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_weather',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'get_weather',
          tool_call_id: 'call_weather',
          content: secret,
        },
      ],
      session,
    );

    expect(encryptedMessages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_weather',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    });

    const toolMessage = encryptedMessages[1];
    expect(toolMessage.name).toBe('get_weather');
    expect(toolMessage.tool_call_id).toBe('call_weather');
    expect(toolMessage.content).not.toBe(secret);
    expect(toolMessage.content).toMatch(/^[0-9a-f]+$/i);
    expect(await decryptWire(toolMessage.content!, modelPrivateKey)).toBe(secret);
  });
});
