# frozen_string_literal: true

require_relative 'lib/x402/version'

Gem::Specification.new do |spec|
  spec.name          = 'x402'
  spec.version       = X402::VERSION
  spec.authors       = ['Coinbase']
  spec.email         = ['support@coinbase.com']

  spec.summary       = 'x402 Payment Protocol SDK for Ruby'
  spec.description   = 'Ruby implementation of the x402 protocol - HTTP 402 Payment Required with cryptocurrency micropayments'
  spec.homepage      = 'https://github.com/coinbase/x402'
  spec.license       = 'Apache-2.0'
  spec.required_ruby_version = '>= 3.0.0'

  spec.metadata = {
    'bug_tracker_uri' => 'https://github.com/coinbase/x402/issues',
    'changelog_uri' => 'https://github.com/coinbase/x402/blob/main/ruby/x402/CHANGELOG.md',
    'documentation_uri' => 'https://x402.org',
    'source_code_uri' => 'https://github.com/coinbase/x402',
    'rubygems_mfa_required' => 'true'
  }

  spec.files = Dir['lib/**/*.rb', 'README.md', 'LICENSE', 'CHANGELOG.md']
  spec.require_paths = ['lib']

  # Core dependencies
  spec.add_dependency 'dry-struct', '~> 1.6'
  spec.add_dependency 'dry-types', '~> 1.7'
  spec.add_dependency 'faraday', '~> 2.0'

  # Development dependencies
  spec.add_development_dependency 'rake', '~> 13.0'
  spec.add_development_dependency 'rspec', '~> 3.12'
  spec.add_development_dependency 'rubocop', '~> 1.50'
  spec.add_development_dependency 'rubocop-rspec', '~> 2.20'
  spec.add_development_dependency 'yard', '~> 0.9'
  spec.add_development_dependency 'webmock', '~> 3.18'
  spec.add_development_dependency 'vcr', '~> 6.1'
  spec.add_development_dependency 'simplecov', '~> 0.22'
end
