/**
 * Wallet Service for Auto-Buy Module
 *
 * Manages private key wallet for executing swaps
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  formatEther,
  parseEther,
  type Account,
  type TransactionRequest,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export class WalletService {
  private account: Account;
  private walletClient: ReturnType<typeof createWalletClient>;
  private publicClient: ReturnType<typeof createPublicClient>;
  private rpcUrl: string;

  constructor(privateKey: string, rpcUrl?: string) {
    if (!privateKey || !privateKey.startsWith("0x")) {
      throw new Error("Invalid private key format");
    }

    this.rpcUrl = rpcUrl || process.env.PONDER_RPC_URL_8453 || "http://127.0.0.1:18545";
    this.account = privateKeyToAccount(privateKey as `0x${string}`);

    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(this.rpcUrl),
    });

    this.publicClient = createPublicClient({
      chain: base,
      transport: http(this.rpcUrl),
    }) as any;

    console.log(`[wallet] Initialized wallet: ${this.account.address}`);
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async getBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async getBalanceEth(): Promise<string> {
    const balance = await this.getBalance();
    return formatEther(balance);
  }

  async getTokenBalance(tokenAddress: `0x${string}`): Promise<bigint> {
    const balance = await this.publicClient.readContract({
      address: tokenAddress,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [this.account.address],
    });
    return balance as bigint;
  }

  async sendTransaction(tx: TransactionRequest): Promise<`0x${string}`> {
    const hash = await this.walletClient.sendTransaction({
      ...tx,
      account: this.account,
      chain: base,
    } as any);
    return hash;
  }

  async writeContract(params: {
    address: `0x${string}`;
    abi: readonly any[];
    functionName: string;
    args?: readonly any[];
    value?: bigint;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }): Promise<`0x${string}`> {
    const hash = await this.walletClient.writeContract({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args ?? [],
      value: params.value,
      gas: params.gas,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      account: this.account,
      chain: base,
    } as any);
    return hash;
  }

  async waitForTransaction(hash: `0x${string}`): Promise<{
    status: "success" | "reverted";
    gasUsed: bigint;
  }> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return {
      status: receipt.status,
      gasUsed: receipt.gasUsed,
    };
  }

  async estimateGas(tx: TransactionRequest): Promise<bigint> {
    return this.publicClient.estimateGas({
      ...tx,
      account: this.account.address,
    } as any);
  }

  async getGasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.publicClient.getBlock();
    const baseFee = block.baseFeePerGas || 0n;

    // Add 20% buffer to base fee
    const maxFeePerGas = (baseFee * 120n) / 100n;

    // Priority fee from env or default 0.1 gwei
    const priorityGwei = Number(process.env.AUTOBUY_GAS_PRIORITY_GWEI || "0.1");
    const maxPriorityFeePerGas = parseEther(priorityGwei.toString()) / 1000000000n;

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  async approveToken(
    tokenAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
    amount: bigint
  ): Promise<`0x${string}`> {
    const hash = await this.writeContract({
      address: tokenAddress,
      abi: [
        {
          name: "approve",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "approve",
      args: [spenderAddress, amount],
    });

    console.log(`[wallet] Approved ${amount} tokens for ${spenderAddress}: ${hash}`);
    return hash;
  }

  async getAllowance(
    tokenAddress: `0x${string}`,
    spenderAddress: `0x${string}`
  ): Promise<bigint> {
    const allowance = await this.publicClient.readContract({
      address: tokenAddress,
      abi: [
        {
          name: "allowance",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "allowance",
      args: [this.account.address, spenderAddress],
    });
    return allowance as bigint;
  }

  getPublicClient(): ReturnType<typeof createPublicClient> {
    return this.publicClient;
  }
}

// Singleton instance
let walletInstance: WalletService | null = null;

export function getWallet(): WalletService {
  if (!walletInstance) {
    const privateKey = process.env.AUTOBUY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("AUTOBUY_PRIVATE_KEY not configured");
    }
    walletInstance = new WalletService(privateKey);
  }
  return walletInstance;
}

export function hasWalletConfigured(): boolean {
  return !!process.env.AUTOBUY_PRIVATE_KEY;
}
