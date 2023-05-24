/**
 * Script to post a remove liquidity offer to the API service.
 * Run: `yarn diva::postRemoveLiquidityOffer`
 */

import fetch from "cross-fetch";
import { ethers, network } from "hardhat";
import { parseUnits } from "@ethersproject/units";
import {
  DIVA_ADDRESS,
  REMOVE_LIQUIDITY_TYPE,
  OfferRemoveLiquidity,
  EIP712API_URL,
} from "../../constants";
import {
  getExpiryTime,
  generateSignatureAndTypedMessageHash,
  writeFile,
} from "../../utils";
import DIVA_ABI from "../../diamondABI/diamond.json";

async function main() {
  // ************************************
  //           INPUT ARGUMENTS
  // ************************************

  // API service URL
  const apiUrl = `${EIP712API_URL[network.name]}/remove_liquidity`;


  const poolId =
    "0x5d829fd4c4a7ea6b5854f4f4b22848ced3dcb5a2914ea9d2f4d28e9f4eb9cf6b";

  // Connect to DIVA contract
  const diva = await ethers.getContractAt(DIVA_ABI, DIVA_ADDRESS[network.name]);

  // Check whether pool exists (collateral token address is zero if it doesn't)
  const poolParamsBefore = await diva.getPoolParameters(poolId);
  if (poolParamsBefore.collateralToken === ethers.constants.AddressZero) {
    console.log("Error: pool Id does not exist");
    return;
  }

  // Get collateral token decimals
  const erc20Contract = await ethers.getContractAt(
    "MockERC20",
    poolParamsBefore.collateralToken
  );
  const decimals = await erc20Contract.decimals();

  // @todo Move up similar to createContingentPool
  const maker = "0x9AdEFeb576dcF52F5220709c1B267d89d5208D78";
  const taker = "0x0000000000000000000000000000000000000000";
  const makerCollateralAmount = parseUnits("1", decimals).toString();
  const positionTokenAmount = parseUnits("1", decimals).toString();
  const makerIsLong = true;
  const offerExpiry = await getExpiryTime(50);
  const minimumTakerFillAmount = parseUnits("1", decimals).toString();
  const salt = Date.now().toString();

  // Prepare remove liquidity offer
  const offerRemoveLiquidity: OfferRemoveLiquidity = {
    maker,
    taker,
    makerCollateralAmount,
    positionTokenAmount,
    makerIsLong,
    offerExpiry,
    minimumTakerFillAmount,
    poolId,
    salt,
  };

  // Prepare data for signing
  const [signer] = await ethers.getSigners();
  const chainId = (await diva.getChainId()).toNumber();
  const verifyingContract = DIVA_ADDRESS[network.name];
  const divaDomain = {
    name: "DIVA Protocol",
    version: "1",
    chainId,
    verifyingContract: DIVA_ADDRESS[network.name],
  };

  // Sign offer
  const [signature] = await generateSignatureAndTypedMessageHash(
    signer,
    divaDomain,
    REMOVE_LIQUIDITY_TYPE,
    offerRemoveLiquidity,
    "OfferRemoveLiquidity"
  );

  // Get offer hash
  const relevantStateParams = await diva.getOfferRelevantStateRemoveLiquidity(
    offerRemoveLiquidity,
    signature
  );
  const offerHash = relevantStateParams.offerInfo.typedOfferHash;

  // Prepare data to be posted to the api server
  const data = {
    ...offerRemoveLiquidity,
    chainId,
    verifyingContract,
    signature,
    offerHash,
  };

  // Post offer data to the api server
  await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  // Save offer as json
  writeFile(
    `offers/removeLiquidityOffer_${offerRemoveLiquidity.salt}.json`,
    JSON.stringify(data)
  );

  console.log("Hash of remove liquidity offer: ", offerHash);

  // Get posted offer
  const getUrl = `${apiUrl}/${offerHash}`;
  const res = await fetch(getUrl, {
    method: "GET",
  });

  console.log(
    "Remove liquidity offer returned from server: ",
    await res.json()
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
