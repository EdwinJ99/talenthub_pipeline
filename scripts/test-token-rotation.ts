import { callActorWithRotation } from "../lib/apify-token-rotation";

async function main() {
  const result = await callActorWithRotation(async (client) => {
    const user = await client.user().get();
    return user;
  });
  console.log("Berhasil pakai token, info akun Apify:", result.username);
}

main();