export function contactSections(state, query = '') {
  const needle = query.trim().toLowerCase();
  const matches = person => `${person.nickname || ''} ${person.code || ''}`.toLowerCase().includes(needle);
  const friendIds = new Set(state.friends.map(person => person.id));
  const pendingIds = new Set(state.requests.flatMap(request => [request.sender, request.recipient]));
  return {
    friends: state.friends.filter(matches),
    requests: state.requests.filter(matches),
    neighbors: state.online.filter(person => person.id !== state.me.id && !friendIds.has(person.id) && !pendingIds.has(person.id) && matches(person))
  };
}
