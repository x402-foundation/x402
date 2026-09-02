/* eslint-disable no-redeclare */
/* global __filename */
import { createRequire } from "node:module";
import type {
  Args as ArgsType,
  CLValue as CLValueType,
  ContractCallBuilder as ContractCallBuilderType,
  Conversions as ConversionsType,
  HttpHandler as HttpHandlerType,
  Key as KeyType,
  KeyAlgorithm as KeyAlgorithmType,
  PrivateKey as PrivateKeyType,
  PublicKey as PublicKeyType,
  RpcClient as RpcClientType,
  SpeculativeClient as SpeculativeClientType,
  Transaction as TransactionType,
} from "casper-js-sdk";

const require = createRequire(typeof __filename !== "undefined" ? __filename : import.meta.url);
const sdk = require("casper-js-sdk");

export const Args = sdk.Args;
export type Args = ArgsType;

export const CLTypeUInt8 = sdk.CLTypeUInt8;

export const CLValue = sdk.CLValue;
export type CLValue = CLValueType;

export const ContractCallBuilder = sdk.ContractCallBuilder;
export type ContractCallBuilder = ContractCallBuilderType;

export const Conversions = sdk.Conversions;
export type Conversions = ConversionsType;

export const HttpHandler = sdk.HttpHandler;
export type HttpHandler = HttpHandlerType;

export const Key = sdk.Key;
export type Key = KeyType;

export const KeyAlgorithm = sdk.KeyAlgorithm;
export type KeyAlgorithm = KeyAlgorithmType;

export const PrivateKey = sdk.PrivateKey;
export type PrivateKey = PrivateKeyType;

export const PublicKey = sdk.PublicKey;
export type PublicKey = PublicKeyType;

export const RpcClient = sdk.RpcClient;
export type RpcClient = RpcClientType;

export const SpeculativeClient = sdk.SpeculativeClient;
export type SpeculativeClient = SpeculativeClientType;

export const Transaction = sdk.Transaction;
export type Transaction = TransactionType;
