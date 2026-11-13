# Contributing to x402 Ruby SDK

Thank you for your interest in contributing to the x402 Ruby SDK! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Code Style](#code-style)
- [Documentation](#documentation)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

## Code of Conduct

This project follows the x402 protocol community standards. Be respectful, inclusive, and collaborative.

## Getting Started

### Prerequisites

- Ruby 3.0 or higher
- Bundler 2.0 or higher
- Git

### Optional Dependencies

For full functionality:
- `eth` gem (for EVM support)
- `base58` and `ed25519` gems (for SVM support)

## Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/YOUR_USERNAME/x402.git
cd x402/ruby/x402
```

2. **Install dependencies**

```bash
bundle install
```

3. **Run tests**

```bash
bundle exec rspec
```

4. **Start console**

```bash
bundle exec rake console
```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feature/add-polygon-support` - New features
- `fix/signature-verification` - Bug fixes
- `docs/improve-client-guide` - Documentation
- `refactor/simplify-hooks` - Code refactoring

### Commit Messages

Follow conventional commits:

```
type(scope): description

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:
```
feat(evm): add Polygon network support

- Add USDC contract address for Polygon
- Update network configs
- Add tests for Polygon

Closes #123
```

```
fix(client): handle nil payment requirements

Previously crashed when server returned empty requirements.
Now raises NoMatchingRequirementsError with clear message.

Fixes #456
```

## Testing

### Running Tests

```bash
# All tests
bundle exec rspec

# Unit tests only
bundle exec rake unit

# Integration tests only
bundle exec rake integration

# Specific file
bundle exec rspec spec/unit/client_spec.rb

# Specific test
bundle exec rspec spec/unit/client_spec.rb:25

# With coverage
COVERAGE=1 bundle exec rspec
```

### Writing Tests

**Unit tests** should:
- Test one component in isolation
- Use mocks for dependencies
- Be fast (<10ms per test)
- Cover edge cases and errors

Example:
```ruby
RSpec.describe X402::Client do
  let(:mock_scheme) { instance_double(X402::SchemeNetworkClient) }
  let(:client) { described_class.new }
  
  describe '#register' do
    it 'registers a scheme for a network' do
      client.register('eip155:8453', mock_scheme)
      # Assertions
    end
  end
end
```

**Integration tests** should:
- Test multiple components together
- Use real implementations (not mocks)
- Test end-to-end flows
- Use VCR for HTTP requests

Example:
```ruby
RSpec.describe 'Full Payment Flow', type: :integration do
  it 'completes successful payment' do
    # Set up client, server, facilitator
    # Execute full flow
    # Verify outcome
  end
end
```

### Coverage Requirements

- Minimum 80% code coverage
- New features must include tests
- Bug fixes must include regression tests

## Code Style

### Ruby Style Guide

Follow the [Ruby Style Guide](https://rubystyle.guide/):

```ruby
# Good
def create_payment_payload(requirements)
  validate_requirements(requirements)
  build_payload(requirements)
end

# Bad
def create_payment_payload( requirements )
  if requirements == nil
    raise "invalid"
  end
  return buildPayload( requirements )
end
```

### RuboCop

Run RuboCop before committing:

```bash
bundle exec rubocop

# Auto-fix issues
bundle exec rubocop -a
```

### Naming Conventions

- **Classes/Modules**: `PascalCase`
- **Methods/Variables**: `snake_case`
- **Constants**: `SCREAMING_SNAKE_CASE`
- **Private methods**: Prefix with `private` keyword

```ruby
module X402
  class PaymentClient  # PascalCase
    MAX_RETRIES = 3    # SCREAMING_SNAKE_CASE
    
    def create_payment(requirements)  # snake_case
      internal_helper(requirements)
    end
    
    private
    
    def internal_helper(data)  # private method
      # Implementation
    end
  end
end
```

### Documentation

Use YARD for API documentation:

```ruby
##
# Creates a signed payment payload.
#
# @param requirements [PaymentRequirements] payment requirements from server
# @param resource [ResourceInfo, nil] optional resource info
# @return [PaymentPayload] signed payment payload
# @raise [NoMatchingRequirementsError] if no compatible payment method
#
# @example Create payment for API access
#   payload = client.create_payment_payload(payment_required)
#   puts payload.to_json
#
def create_payment_payload(requirements, resource: nil)
  # Implementation
end
```

## Documentation

### Updating Documentation

When making changes, update:

1. **Code comments** - YARD documentation
2. **README.md** - If changing core functionality
3. **Guides** - CLIENT.md, SERVER.md, FACILITATOR.md
4. **CHANGELOG.md** - Add entry under Unreleased

### Building Documentation

```bash
# Generate YARD docs
bundle exec rake docs

# View locally
open doc/index.html
```

### Writing Guides

- Use clear, simple language
- Include code examples
- Explain the "why" not just the "how"
- Link to related concepts
- Test all examples

## Pull Request Process

### Before Submitting

1. **Run tests**: `bundle exec rspec`
2. **Run linter**: `bundle exec rubocop`
3. **Update CHANGELOG**: Add entry under Unreleased
4. **Update docs**: If changing public APIs
5. **Rebase on main**: `git rebase origin/main`

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
How was this tested?

## Checklist
- [ ] Tests pass
- [ ] Linter passes
- [ ] Documentation updated
- [ ] CHANGELOG updated
```

### Review Process

1. **Automated checks** must pass (tests, linter)
2. **Code review** by maintainer
3. **Documentation review** if applicable
4. **Integration testing** for significant changes

### Merging

- Squash commits for clean history
- Maintainers will merge approved PRs
- CI will run final checks

## Release Process

Maintainers handle releases:

1. **Update version** in `lib/x402/version.rb`
2. **Update CHANGELOG** - Move Unreleased to version section
3. **Create git tag**: `git tag v0.2.0`
4. **Push tag**: `git push origin v0.2.0`
5. **Build gem**: `gem build x402.gemspec`
6. **Push to RubyGems**: `gem push x402-0.2.0.gem`

## Common Tasks

### Adding a New Network

1. **Add network config** to constants:
```ruby
# lib/x402/mechanisms/evm/constants.rb
NETWORK_CONFIGS = {
  'eip155:NEW_CHAIN_ID' => NetworkConfig.new(
    chain_id: NEW_CHAIN_ID,
    default_asset: AssetInfo.new(...),
    supported_assets: { ... }
  )
}.freeze
```

2. **Add tests**:
```ruby
# spec/unit/mechanisms/evm/constants_spec.rb
it 'has config for new network' do
  config = Constants::NETWORK_CONFIGS['eip155:NEW_CHAIN_ID']
  expect(config).to be_a(Constants::NetworkConfig)
end
```

3. **Update README** with new network
4. **Add integration test** if possible

### Adding a New Scheme

1. **Create scheme directory**: `lib/x402/mechanisms/SCHEME_NAME/`
2. **Implement client scheme**: `SCHEME_NAME/client.rb`
3. **Implement server scheme**: `SCHEME_NAME/server.rb`
4. **Implement facilitator scheme**: `SCHEME_NAME/facilitator.rb`
5. **Add constants**: `SCHEME_NAME/constants.rb`
6. **Add types**: `SCHEME_NAME/types.rb`
7. **Write comprehensive tests**
8. **Document in guides**

### Fixing a Bug

1. **Create failing test** that reproduces bug
2. **Fix the bug**
3. **Verify test passes**
4. **Add regression test** if needed
5. **Update CHANGELOG**

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **Discussions**: Ask questions or discuss ideas
- **Discord**: Real-time chat (link in main repo)
- **Email**: security@x402.org for security issues

## Security Issues

**Do not** open public issues for security vulnerabilities.

Email security@x402.org with:
- Description of vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Recognition

Contributors will be:
- Listed in CHANGELOG for their contributions
- Mentioned in release notes
- Added to contributors list (if significant contributions)

## Questions?

Feel free to:
- Open a discussion on GitHub
- Ask in Discord
- Comment on related issues

Thank you for contributing! 🎉
