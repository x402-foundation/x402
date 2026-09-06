import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * x402 CloudFront + Lambda@Edge stack.
 *
 * Deploys two Lambda@Edge functions that add x402 payment verification to any
 * HTTP origin — without modifying the origin itself.
 *
 * Prerequisites: run `pnpm build` in the ../lambda directory before deploying.
 */
export class X402Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda bundle built by running `pnpm build` in ../lambda
    const lambdaCode = lambda.Code.fromAsset(
      path.join(__dirname, '../../lambda/dist'),
    );

    // EdgeFunction automatically deploys to us-east-1 regardless of the stack region,
    // which is a hard requirement for Lambda@Edge.
    // It also sets the correct IAM trust policy (lambda + edgelambda principals) automatically.
    const originRequestFn = new cloudfront.experimental.EdgeFunction(
      this,
      'OriginRequest',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.originRequestHandler',
        code: lambdaCode,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        description: 'x402 payment verification — runs before request reaches origin',
      },
    );

    const originResponseFn = new cloudfront.experimental.EdgeFunction(
      this,
      'OriginResponse',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.originResponseHandler',
        code: lambdaCode,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        description: 'x402 payment settlement — runs only when origin returns success',
      },
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'x402 workshop distribution',
      // North America and Europe only — cheapest option for testing.
      // Change to PriceClass.PRICE_CLASS_ALL for global production use.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        // Replace 'httpbin.org' with your own origin for production use.
        origin: new origins.HttpOrigin('httpbin.org', {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Disable caching for testing so every request hits Lambda@Edge.
        // For production, configure a cache policy appropriate to your content.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Pass all client headers (including PAYMENT-SIGNATURE) to Lambda and origin.
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
        edgeLambdas: [
          {
            functionVersion: originRequestFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: true,
          },
          {
            functionVersion: originResponseFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront domain — use this URL to test your x402 endpoints',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });
  }
}
