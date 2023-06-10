/**
 * Script to retrieve a create contingent pool offer from the API service
 * and fill it. Approval for maker and taker is set inside the script for ease of use.
 * Run: `yarn diva::fillOfferCreateContingentPool_from_api --network mumbai`
 * 
 * Example usage (append corresponding network):
 * 1. `yarn diva::postCreateContingentPoolOffer`: Post a create offer to the API server.
 * 2. `yarn diva::getOfferRelevantStateCreateContingentPool`: Check the offer state.
 * 3. `yarn diva::fillOfferCreateContingentPool_from_api`: Fill the offer.
 * 4. `yarn diva::getOfferRelevantStateCreateContingentPool`: Check the offer state.
 */

import fetch from "cross-fetch";
import { ethers, network } from "hardhat";
import { BigNumber, Contract } from "ethers";
import { parseUnits, formatUnits } from "@ethersproject/units";
import DIVA_ABI from "../../diamondABI/diamond.json";
import {
  OfferCreateContingentPool,
  Signature,
  DivaDomain,
  CREATE_POOL_TYPE,
  DIVA_ADDRESS,
  OfferStatus,
  EIP712API_URL,
} from "../../constants";

async function main() {
  // ************************************
  //           INPUT ARGUMENTS
  // ************************************

  // Hash of offer to fill
  const offerHash =
    "0x365cbf1ca6a19608624d70cef87ebd92bc2a8c86cbe25dc359e536966ebf1e31";

  // Get signers
  const [, taker] = await ethers.getSigners();

  // Taker fill amount. Conversion into integer happens in the code below as it
  // depends on the collateral token decimals.
  const takerFillAmountInput = "1"; 

  // ************************************
  //              EXECUTION
  // ************************************

  // Get offer info from API service
  const getURL = `${EIP712API_URL[network.name]}/create_contingent_pool/${offerHash}`;
  const res = await fetch(
    getURL,
    {
      method: "GET",
    }
  );
  const offerInfo = await res.json();

  // Connect to the collateral token to obtain the decimals needed to convert into
  // integer representation
  const collateralToken = await ethers.getContractAt(
    "MockERC20",
    offerInfo.collateralToken
  );
  const decimals = await collateralToken.decimals();

  // Connect to deployed DIVA contract
  const diva = await ethers.getContractAt(DIVA_ABI, DIVA_ADDRESS[network.name]);

  // Define DIVA Domain struct
  const divaDomain = {
    name: "DIVA Protocol",
    version: "1",
    chainId: offerInfo.chainId,
    verifyingContract: offerInfo.verifyingContract,
  };

  // Get offerCreateContingentPool from offer info
  const offerCreateContingentPool = offerInfo as OfferCreateContingentPool;

  // Get signature from offerInfo
  const signature = offerInfo.signature;

  // Set takerFillAmount
  const takerFillAmount = parseUnits(takerFillAmountInput, decimals);

  // Calculate makerFillAmount
  const makerFillAmount = BigNumber.from(
    offerCreateContingentPool.makerCollateralAmount
  )
    .mul(takerFillAmount)
    .div(offerCreateContingentPool.takerCollateralAmount);

  // Get maker signer. Must be an account derived from the MNEMONIC stored in `.env`.
  const maker = await ethers.getSigner(offerCreateContingentPool.maker);

  // The following code checks whether the maker and taker have sufficient allowance and
  // collateral token balance. It will set the allowance if insufficient.
  
  // Get maker's and taker's collateral token balance
  const collateralTokenBalanceMakerBefore = await collateralToken.balanceOf(
    maker.address
  );
  const collateralTokenBalanceTakerBefore = await collateralToken.balanceOf(
    taker.address
  );

  // Get makers's and taker's current allowance
  let allowanceMaker = await collateralToken.allowance(
    maker.address,
    diva.address
  );
  let allowanceTaker = await collateralToken.allowance(
    taker.address,
    diva.address
  );

  if (taker.address === offerCreateContingentPool.maker) {
    // Set allowance to makerCollateralAmount + takerCollateralAmount when taker = maker
    const totalCollateralFillAmount = BigNumber.from(
      offerCreateContingentPool.makerCollateralAmount
    )
      .add(offerCreateContingentPool.takerCollateralAmount)
      .mul(takerFillAmount)
      .div(offerCreateContingentPool.takerCollateralAmount);
    if (allowanceMaker.lt(totalCollateralFillAmount)) {
      const approveTx = await collateralToken
        .connect(maker)
        .approve(diva.address, totalCollateralFillAmount.add(1)); // added a buffer to avoid any issues during fill tx due to rounding
      await approveTx.wait();

      // Get maker's new allowance
      allowanceMaker = await collateralToken.allowance(
        maker.address,
        diva.address
      );
      allowanceTaker = allowanceMaker; // because taker = maker
    }
  } else {
    // Set maker allowance if insufficient    
    if (allowanceMaker.lt(makerFillAmount)) {
      const approveTx = await collateralToken
        .connect(maker)
        .approve(diva.address, makerFillAmount.add(1)); // added a buffer to avoid any issues during fill tx due to rounding
      await approveTx.wait();

      // Get maker's new allowance
      allowanceMaker = await collateralToken.allowance(
        maker.address,
        diva.address
      );
    }

    // Set taker allowance if insufficient
    if (allowanceTaker.lt(takerFillAmount)) {
      const approveTx = await collateralToken
        .connect(taker)
        .approve(diva.address, takerFillAmount.add(1)); // added a buffer to avoid any issues during fill tx due to rounding
      await approveTx.wait();

      // Get taker's new allowance
      allowanceTaker = await collateralToken.allowance(
        taker.address,
        diva.address
      );
    }
  }

  // Check conditions to ensure a successful fill offer tx
  await _checkConditions(
    diva,
    divaDomain,
    offerCreateContingentPool,
    CREATE_POOL_TYPE,
    signature,
    taker.address,
    takerFillAmount,
    makerFillAmount,
    collateralTokenBalanceTakerBefore,
    collateralTokenBalanceMakerBefore
  );

  // Get taker filled amount before fill offer
  const takerFilledAmountBefore = await diva.getTakerFilledAmount(offerHash);

  // Fill offer with taker account
  const tx = await diva
    .connect(taker)
    .fillOfferCreateContingentPool(
      offerCreateContingentPool,
      signature,
      takerFillAmount
    );
  const receipt = await tx.wait();

  console.log("Offer successfully filled");

  // Get newly created pool Id via the typedOfferHash emitted via the OfferFilled event
  const typedOfferHash = receipt.events.find(
    (x: any) => x.event === "OfferFilled"
  ).args.typedOfferHash;
  const poolId = (
    await diva.getPoolIdByTypedCreateOfferHash(typedOfferHash)
  ).toString();

  // Get maker's and taker's ERC20 token balance after fill offer
  const collateralTokenBalanceMakerAfter = await collateralToken.balanceOf(
    maker.address
  );
  const collateralTokenBalanceTakerAfter = await collateralToken.balanceOf(
    taker.address
  );

  // Get taker filled amount after fill offer
  const takerFilledAmountAfter = await diva.getTakerFilledAmount(offerHash);

  // Log relevant info
  console.log("chainId", offerInfo.chainId);
  console.log("DIVA address: ", diva.address);
  console.log("PoolId of newly created pool: ", poolId.toString());
  console.log("offerCreateContingentPool object: ", offerCreateContingentPool);
  console.log("Allowance Maker: ", formatUnits(allowanceMaker, decimals));
  console.log("Allowance Taker: ", formatUnits(allowanceTaker, decimals));
  console.log(
    "Collateral token balance Maker before: ",
    formatUnits(collateralTokenBalanceMakerBefore, decimals)
  );
  console.log(
    "Collateral token balance Taker before: ",
    formatUnits(collateralTokenBalanceTakerBefore, decimals)
  );
  console.log(
    "offerCreateContingentPool.makerCollateralAmount",
    formatUnits(offerCreateContingentPool.makerCollateralAmount, decimals)
  );
  console.log(
    "offerCreateContingentPool.takerCollateralAmount",
    formatUnits(offerCreateContingentPool.takerCollateralAmount, decimals)
  );
  console.log(
    "Collateral token balance Maker after: ",
    formatUnits(collateralTokenBalanceMakerAfter, decimals)
  );
  console.log(
    "Collateral token balance Taker after: ",
    formatUnits(collateralTokenBalanceTakerAfter, decimals)
  );
  console.log(
    "Taker filled amount before: ",
    formatUnits(takerFilledAmountBefore, decimals)
  );
  console.log(
    "Taker filled amount after: ",
    formatUnits(takerFilledAmountAfter, decimals)
  );
}

// Auxiliary function to perform checks required for successful execution, in line with those implemented
// inside the smart contract function. It is recommended to perform those checks in frontend applications
// to save users gas fees on reverts. Alternatively, use Tenderly to pre-simulate the tx and catch any errors
// before actually executing it.
const _checkConditions = async (
  diva: Contract,
  divaDomain: DivaDomain,
  offerCreateContingentPool: OfferCreateContingentPool,
  type: Record<string, { type: string; name: string }[]>,
  signature: Signature,
  userAddress: string,
  takerFillAmount: BigNumber,
  makerFillAmount: BigNumber,
  takerCollateralTokenBalance: BigNumber,
  makerCollateralTokenBalance: BigNumber,
) => {
  // Get information about the state of the create contingent pool offer
  const relevantStateParams =
    await diva.getOfferRelevantStateCreateContingentPool(
      offerCreateContingentPool,
      signature
    );

  // Confirm that the offer is fillable
  // 0: INVALID, 1: CANCELLED, 2: FILLED, 3: EXPIRED, 4: FILLABLE
  if (relevantStateParams.offerInfo.status === OfferStatus.Invalid) {
    throw new Error("Offer is invalid because takerCollateralAmount is zero.");
  }

  if (relevantStateParams.offerInfo.status === OfferStatus.Cancelled) {
    throw new Error("Offer was cancelled.");
  }

  if (relevantStateParams.offerInfo.status === OfferStatus.Filled) {
    throw new Error("Offer is already filled.");
  }

  if (relevantStateParams.offerInfo.status === OfferStatus.Expired) {
    throw new Error("Offer is already expired.");
  }

  // Confirm that the contingent pool parameters are valid
  if (!relevantStateParams.isValidInputParamsCreateContingentPool) {
    throw new Error("Invalid create contingent pool parameters.");
  }

  // Confirm that takerFillAmount does not exceed actualTakerFillableAmount
  if (relevantStateParams.actualTakerFillableAmount.lt(takerFillAmount)) {
    throw new Error(
      "Actually fillable amount is smaller than takerFillAmount."
    );
  }

  // Confirm that signature matches the offer
  const recoveredAddress = ethers.utils.verifyTypedData(
    divaDomain,
    type,
    offerCreateContingentPool,
    signature
  );
  if (recoveredAddress != offerCreateContingentPool.maker) {
    throw new Error("Invalid signature.");
  }

  // Check that taker is allowed to fill the offer (relevant if taker specified in the offer is not the zero address)
  if (
    offerCreateContingentPool.taker != ethers.constants.AddressZero &&
    userAddress != offerCreateContingentPool.taker
  ) {
    throw new Error("Offer is reserved for a different address.");
  }

  // Confirm that takerFillAmount >= minimumTakerFillAmount **on first fill**.
  // Minimum is not relevant on second fill (i.e. when takerFilledAmount > 0)
  if (
    relevantStateParams.offerInfo.takerFilledAmount.eq(0) &&
    takerFillAmount.lt(offerCreateContingentPool.minimumTakerFillAmount)
  ) {
    throw new Error("takerFillAmount is smaller than minimumTakerFillAmount.");
  }

  // Check that the taker has sufficient collateral token balance
  if (takerCollateralTokenBalance.lt(takerFillAmount)) {
    throw new Error("Taker has insufficient collateral token balance.");
  }

  // Check that the maker has sufficient collateral token balance
  if (makerCollateralTokenBalance.lt(makerFillAmount)) {
    throw new Error("Maker has insufficient collateral token balance.");
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
