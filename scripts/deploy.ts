import { ethers, network } from "hardhat";

/**
 * Deploys NairaAidCampaigns and, if no real cNGN address is given, a MockCNGN for testing.
 *
 * Env (see .env.example; never commit keys):
 *   DEPLOYER_PRIVATE_KEY  - deployer key, read by hardhat.config.ts
 *   CNGN_ADDRESS          - existing cNGN token address. Empty = deploy MockCNGN (testnets only)
 *   MOCK_MINT_NGN         - whole naira of MockCNGN to mint to the deployer (default 1,000,000)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer account. Set DEPLOYER_PRIVATE_KEY in .env");
  }
  console.log(`Network:  ${network.name} (chainId ${network.config.chainId ?? "local"})`);
  console.log(`Deployer: ${deployer.address}`);

  let tokenAddress = process.env.CNGN_ADDRESS;
  if (!tokenAddress) {
    const mock = await (await ethers.getContractFactory("MockCNGN")).deploy(deployer.address);
    await mock.waitForDeployment();
    tokenAddress = await mock.getAddress();
    console.log(`MockCNGN deployed at ${tokenAddress} (TEST TOKEN - not real naira)`);
    const mintNgn = process.env.MOCK_MINT_NGN ?? "1000000";
    if (Number(mintNgn) > 0) {
      await (await mock.mint(deployer.address, ethers.parseUnits(mintNgn, 6))).wait();
      console.log(`Minted ₦${Number(mintNgn).toLocaleString("en-NG")} test cNGN to deployer`);
    }
  } else {
    console.log(`Using existing cNGN at ${tokenAddress}`);
  }

  const aid = await (await ethers.getContractFactory("NairaAidCampaigns")).deploy();
  await aid.waitForDeployment();
  const aidAddress = await aid.getAddress();
  console.log(`NairaAidCampaigns deployed at ${aidAddress}`);

  console.log("\nFor the dashboard / scripts:");
  console.log(`NAIRAAID_CONTRACT=${aidAddress}`);
  console.log(`CNGN_ADDRESS=${tokenAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
