import * as cdk from 'aws-cdk-lib';
import { X402Stack } from '../lib/x402-stack';

const app = new cdk.App();

new X402Stack(app, 'X402CloudFrontStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'x402 payment gate using CloudFront + Lambda@Edge',
});
