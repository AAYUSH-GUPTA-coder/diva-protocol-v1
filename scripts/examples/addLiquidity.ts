/**
 * Script to add liquidity to an existing contingent pool.
 * Run: `yarn diva::addLiquidity --network mumbai`
 *
 * Example usage (append corresponding network):
 * 1. `yarn diva::createContingentPool`: Create pool.
 * 2. `yarn diva::getPoolParameters`: Check the collateral balance before adding liquidity.
 * 3. `yarn diva::addLiquidity`: Add more collateral to the pool.
 * 4. `yarn diva::getPoolParameters`: Check the updated collateral balance.
 */

import { ethers, network } from "hardhat";
import { BigNumber } from "ethers";
import { parseUnits, formatUnits } from "@ethersproject/units";
import { LibDIVAStorage } from "../../typechain-types/contracts/facets/GetterFacet";
import DIVA_ABI from "../../diamondABI/diamond.json";
import { DIVA_ADDRESS } from "../../constants";
import { getCurrentTimestamp } from "../../utils";

async function main() {
  // ************************************
  //           INPUT ARGUMENTS
  // ************************************

  // Id of an existing pool
  const poolId =
    "0x1de191d66c6848d7c0d33d16b5041cd0ac5c46f208650cf63e1f3c96d4b3a521";

  // Collateral token amount to be added to an existing pool. Conversion into
  // integer happens below in the code as it depends on the collateral token decimals.
  const additionalAmountString = "3";

  // Long & short token recipients
  const longRecipient = "0xcBA1fBd153291Ab72055193Fa5615660d54eD370";
  const shortRecipient = "0x00169E8d26FB0Bc936c0893d95922bbd0b50b88c";

  // Set liquidity provider's account
  const [liquidityProvider] = await ethers.getSigners();

  // ************************************
  //              EXECUTION
  // ************************************

  // Connect to deployed DIVA contract
  const diva = await ethers.getContractAt(DIVA_ABI, DIVA_ADDRESS[network.name]);

  // Get pool parameters before new liquidity is added
  const poolParamsBefore = await diva.getPoolParameters(poolId);

  // Connect to ERC20 collateral token
  const erc20Contract = await ethers.getContractAt(
    "MockERC20",
    poolParamsBefore.collateralToken
  );

  // Convert tip amount into integer format expected by `addLiquidity` function
  const decimals = await erc20Contract.decimals();
  const additionalAmount = parseUnits(additionalAmountString, decimals);

  // Get liquidityProvider's collateral token balances
  const balance = await erc20Contract.balanceOf(liquidityProvider.address);

  // Confirm that all conditions are met before continuing
  await _checkConditions(
    poolParamsBefore,
    additionalAmount,
    longRecipient,
    shortRecipient,
    balance
  );

  // Get liquidityProvider's current allowance
  let allowance = await erc20Contract.allowance(
    liquidityProvider.address,
    diva.address
  );

  // Increase allowance if insufficient
  if (allowance.lt(additionalAmount)) {
    const approveTx = await erc20Contract.approve(
      diva.address,
      additionalAmount
    );
    await approveTx.wait();

    // Get liquidity provider's new allowance
    allowance = await erc20Contract.allowance(
      liquidityProvider.address,
      diva.address
    );
  }

  // Add liquidity
  const tx = await diva.addLiquidity(
    poolId,
    additionalAmount,
    longRecipient,
    shortRecipient
  );
  await tx.wait();

  // Get pool parameters and position token supply after new liquidity has been added
  const poolParamsAfter = await diva.getPoolParameters(poolId);
  const longTokenInstance = await ethers.getContractAt(
    "PositionToken",
    poolParamsAfter.longToken
  );
  const shortTokenInstance = await ethers.getContractAt(
    "PositionToken",
    poolParamsAfter.shortToken
  );
  const supplyShort = await shortTokenInstance.totalSupply();
  const supplyLong = await longTokenInstance.totalSupply();

  // Log relevant info
  console.log("DIVA address: ", diva.address);
  console.log("PoolId: ", poolId);
  console.log(
    "Pool collateral balance before: ",
    formatUnits(poolParamsBefore.collateralBalance, decimals)
  );
  console.log(
    "New collateral amount added: ",
    formatUnits(additionalAmount, decimals)
  );
  console.log(
    "Pool collateral balance after: ",
    formatUnits(poolParamsAfter.collateralBalance, decimals)
  );
  console.log("Liquidity added by: ", liquidityProvider.address);
  console.log("Long token recipient: ", longRecipient);
  console.log("Short token recipient: ", shortRecipient);
  console.log("Long token address: ", poolParamsBefore.longToken);
  console.log("Short token address: ", poolParamsBefore.shortToken);
  console.log("New long token supply: ", formatUnits(supplyLong, decimals));
  console.log("New short token supply: ", formatUnits(supplyShort, decimals));
}

// Auxiliary function to perform checks required for successful execution, in line with those implemented
// inside the smart contract function. It is recommended to perform those checks in frontend applications
// to save users gas fees on reverts. Alternatively, use Tenderly to pre-simulate the tx and catch any errors
// before actually executing it.
const _checkConditions = async (
  poolParams: LibDIVAStorage.PoolStruct,
  additionalAmount: BigNumber,
  longRecipient: string,
  shortRecipient: string,
  collateralBalanceUser: BigNumber
) => {
  // Get current time (proxy for block timestamp)
  const now = getCurrentTimestamp();

  // Check that longRecipient does not equal to the zero address
  if (longRecipient === ethers.constants.AddressZero) {
    throw new Error("Long token recipient cannot be the zero address.");
  }

  // Check that shortRecipient does not equal to the zero address
  if (shortRecipient === ethers.constants.AddressZero) {
    throw new Error("Short token recipient cannot be the zero address.");
  }

  // Check that pool didn't expiry yet
  if (now >= Number(poolParams.expiryTime)) {
    throw new Error(
      "Pool already expired. No addition of liquidity possible anymore."
    );
  }

  // Check that pool capacity is not exceeded
  if (
    BigNumber.from(poolParams.collateralBalance)
      .add(additionalAmount)
      .gt(BigNumber.from(poolParams.capacity))
  ) {
    throw new Error("Pool capacity exceeded.");
  }

  // Check user's collateral token balance
  if (collateralBalanceUser.lt(additionalAmount)) {
    throw new Error("Insufficient collateral tokens in wallet.");
  }

  // Note that additional of liquidity will not be possible if the collateral token
  // activated a transfer fee after the pool was created.
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
