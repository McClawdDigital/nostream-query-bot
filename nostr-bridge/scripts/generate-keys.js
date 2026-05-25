const { generateSecretKey, getPublicKey } = require('nostr-tools/pure')
const { nip19 } = require('nostr-tools')

let sk = generateSecretKey()
let pk = getPublicKey(sk)

const nsec = nip19.nsecEncode(sk)
const npub = nip19.npubEncode(pk)

console.log('\n=== BOT KEYPAIR ===')
console.log(`nsec (keep secret): ${nsec}`)
console.log(`npub (public):     ${npub}`)
console.log(`hex pub key:       ${pk}`)
console.log()
console.log('Save the nsec in Bitwarden or your vault.')
console.log('Share the npub with users who want to interact with the bot.')
console.log()
