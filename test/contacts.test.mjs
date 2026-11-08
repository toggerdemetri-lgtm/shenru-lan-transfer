import { test } from 'node:test';
import assert from 'node:assert/strict';
test('friend list includes online neighbors and incoming requests without duplicate rows', async () => {
  const { contactSections } = await import('../public/contacts.js');
  const result = contactSections({ me: { id: 'me' }, friends: [{ id: 'friend', nickname: '好友' }],
    online: [{ id: 'friend', nickname: '好友' }, { id: 'new', nickname: '在线新朋友' }, { id: 'pending', nickname: '已申请' }],
    requests: [{ sender: 'pending', recipient: 'me', nickname: '已申请' }] });
  assert.equal(result.friends.length, 1);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.neighbors.map(x => x.id), ['new']);
});
test('one friend-list search covers friends, requests and neighbors, including friend codes', async () => {
  const { contactSections } = await import('../public/contacts.js');
  const state = { me: { id: 'me' }, friends: [{ id: 'f', nickname: 'Alice', code: 'ABC12345' }], online: [{ id: 'n', nickname: '邻居', code: 'DEF67890' }], requests: [] };
  assert.equal(contactSections(state, 'alice').friends.length, 1);
  assert.equal(contactSections(state, 'def67890').neighbors.length, 1);
  assert.equal(contactSections(state, '没有此人').neighbors.length, 0);
});
