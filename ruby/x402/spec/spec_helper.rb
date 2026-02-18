# frozen_string_literal: true

require 'bundler/setup'
require 'simplecov'

# Start SimpleCov for coverage reporting
SimpleCov.start do
  add_filter '/spec/'
  add_filter '/examples/'
  add_group 'Core', 'lib/x402'
  add_group 'Schemas', 'lib/x402/schemas'
  add_group 'HTTP', 'lib/x402/http'
  add_group 'EVM', 'lib/x402/mechanisms/evm'
  add_group 'SVM', 'lib/x402/mechanisms/svm'
end

# Load x402
require 'x402'

# Test utilities
require 'webmock/rspec'
require 'vcr'

# Disable external HTTP requests
WebMock.disable_net_connect!(allow_localhost: true)

# Configure VCR for HTTP fixture recording
VCR.configure do |config|
  config.cassette_library_dir = 'spec/fixtures/vcr_cassettes'
  config.hook_into :webmock
  config.configure_rspec_metadata!
  config.default_cassette_options = {
    record: :once,
    match_requests_on: [:method, :uri, :body]
  }
end

# RSpec configuration
RSpec.configure do |config|
  # Enable flags like --only-failures and --next-failure
  config.example_status_persistence_file_path = '.rspec_status'

  # Disable RSpec exposing methods globally on `Module` and `main`
  config.disable_monkey_patching!

  # Use expect syntax
  config.expect_with :rspec do |c|
    c.syntax = :expect
    c.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  # Configure mocks
  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end

  # Warnings
  config.warnings = true

  # Print the 10 slowest examples
  config.profile_examples = 10 if ENV['PROFILE']

  # Run specs in random order
  config.order = :random
  Kernel.srand config.seed

  # Allow tagging for selective runs
  config.filter_run_when_matching :focus

  # Shared context for all tests
  config.before(:each) do
    # Reset any global state if needed
  end

  config.after(:each) do
    # Clean up after each test
  end
end

# Helper to load fixtures
def load_fixture(filename)
  File.read(File.join(__dir__, 'fixtures', filename))
end

# Helper to parse JSON fixtures
def load_json_fixture(filename)
  JSON.parse(load_fixture(filename))
end
