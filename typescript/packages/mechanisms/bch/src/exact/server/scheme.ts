import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from '@x402/core/types';
import { BCH_ASSET, DEFAULT_BCH_POLICY, isCashTokenCategory } from '../../crypto';
import type { BchPrice, ExactBchRequirements } from '../../types';

export class ExactBchServerScheme implements SchemeNetworkServer {
  readonly scheme = 'exact';
  readonly defaultAssetTransferMethod = 'native';
  readonly paymentFlows = {
    native: { supported: ['upfront'], default: 'upfront' },
    cashtoken: { supported: ['upfront'], default: 'upfront' },
  } as const satisfies Readonly<Record<string, PaymentFlowConfig>>;
  private readonly moneyParsers: MoneyParser[] = [];

  registerMoneyParser(parser: MoneyParser): this {
    this.moneyParsers.push(parser);
    return this;
  }

  getAssetDecimals(asset: string, _network: Network): number | undefined {
    if (asset === BCH_ASSET) return 8;
    return isCashTokenCategory(asset) ? 0 : undefined;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    const bchPrice = price as BchPrice;
    if (typeof bchPrice === 'object' && bchPrice !== null && 'amount' in bchPrice) {
      if (bchPrice.asset === BCH_ASSET) {
        assertSatoshiAmount(bchPrice.amount);
        return {
          amount: bchPrice.amount,
          asset: BCH_ASSET,
          extra: { assetTransferMethod: 'native', paymentFlow: 'upfront', ...bchPrice.extra },
        };
      }
      if (!isCashTokenCategory(bchPrice.asset)) {
        throw new Error('BCH asset must be BCH or a 32-byte CashToken category');
      }
      assertTokenAmount(bchPrice.amount);
      const tokenOutputValueValue =
        bchPrice.extra?.tokenOutputValue ?? String(DEFAULT_BCH_POLICY.dustThreshold);
      if (typeof tokenOutputValueValue !== 'string') {
        throw new Error('CashToken tokenOutputValue must be a satoshi string');
      }
      const tokenOutputValue = tokenOutputValueValue;
      assertSatoshiAmount(tokenOutputValue);
      return {
        amount: bchPrice.amount,
        asset: bchPrice.asset,
        extra: {
          assetTransferMethod: 'cashtoken',
          paymentFlow: 'upfront',
          tokenOutputValue,
          ...bchPrice.extra,
        },
      };
    }
    if (typeof bchPrice === 'string' && /^(0|[1-9][0-9]*)$/.test(bchPrice)) {
      return {
        amount: bchPrice,
        asset: BCH_ASSET,
        extra: { assetTransferMethod: 'native', paymentFlow: 'upfront' },
      };
    }
    for (const parser of this.moneyParsers) {
      const parsed = await parser(String(price), network);
      if (parsed) return parsed;
    }
    throw new Error('BCH prices must specify atomic satoshis as { amount, asset: "BCH" }');
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    const existing = paymentRequirements.extra ?? {};
    if (existing.paymentFlow !== undefined && existing.paymentFlow !== 'upfront') {
      throw new Error('unsupported BCH payment flow');
    }
    const assetTransferMethod =
      existing.assetTransferMethod ??
      (paymentRequirements.asset === BCH_ASSET ? 'native' : 'cashtoken');
    if (assetTransferMethod !== 'native' && assetTransferMethod !== 'cashtoken') {
      throw new Error('unsupported BCH asset transfer method');
    }
    if (assetTransferMethod === 'native' && paymentRequirements.asset !== BCH_ASSET) {
      throw new Error('native BCH requires asset BCH');
    }
    if (assetTransferMethod === 'cashtoken' && !isCashTokenCategory(paymentRequirements.asset)) {
      throw new Error('CashToken payments require a 32-byte category asset');
    }
    const tokenOutputValue =
      assetTransferMethod === 'cashtoken'
        ? ((existing.tokenOutputValue as string | undefined) ??
          String(DEFAULT_BCH_POLICY.dustThreshold))
        : undefined;
    if (tokenOutputValue !== undefined) assertSatoshiAmount(tokenOutputValue);
    return {
      ...paymentRequirements,
      extra: {
        ...existing,
        assetTransferMethod,
        paymentFlow: 'upfront',
        ...(tokenOutputValue === undefined ? {} : { tokenOutputValue }),
      },
    } as ExactBchRequirements;
  }
}

function assertSatoshiAmount(amount: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error('BCH amount must be canonical satoshis');
  const value = BigInt(amount);
  if (value > 0xffffffffffffffffn) throw new Error('BCH amount exceeds u64');
  if (value < DEFAULT_BCH_POLICY.dustThreshold) throw new Error('BCH amount is below dust');
}

function assertTokenAmount(amount: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new Error('CashToken amount must be canonical integer units');
  }
  const value = BigInt(amount);
  if (value === 0n || value > 0x7fffffffffffffffn) {
    throw new Error('CashToken amount is outside the BCH token range');
  }
}
