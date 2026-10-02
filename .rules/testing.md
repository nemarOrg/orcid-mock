# Testing Standards - NO MOCKS Policy

This project is itself a test double for the Open Researcher and Contributor ID (ORCID) service.
The rule still holds for its own tests: they start the real server and drive it over HTTP, and never import a handler to skip the wire.
The exception is code with no HTTP surface, which is tested directly with real inputs and no stand-ins: the checksum, the fixture loader, and the `Store` contract suite (`tests/helpers/store-contract.ts`, written so any `Store` implementation can run it).
The record section builders are tested the same way in `tests/record-project.test.ts`, on stored users built by the real loader and then edited, because HTTP cannot give one user items with different stamps.
The only thing faked here is ORCID, deliberately and faithfully.

## Core Philosophy: Test Reality, Not Fiction
**Why NO MOCKS?** Mocks test your assumptions, not your code.  
**Real bugs** hide in integration points, not unit logic.  
**Better approach:** No test is better than a false-confidence mock test.

## [STRICT] NO MOCKS, NO FAKE DATA
Never use mocks, stubs, or fake datasets. If real testing isn't possible, don't write tests.
- **No mock objects** - Use real implementations
- **No mock datasets** - Use actual sample data
- **No stub services** - Connect to real test instances
- **Alternative:** Ask user for sample data or test environment setup

## When to Write Tests
- **DO:** Test with real data and actual dependencies
- **DO:** Use test databases with real schemas
- **DO:** Test against actual file systems
- **DON'T:** Write tests if only mocks would work
- **DON'T:** Create artificial test scenarios

## Test Structure
```
tests/
  conftest.py          # Real test fixtures
  sample_data/         # Actual data samples (user-provided)
    valid/
    invalid/
  integration/         # Tests with real dependencies
    test_database.py   # Real DB connection
    test_api.py        # Real API calls
```

## Frameworks (Language-Specific)
- **Python:** `pytest` with real fixtures
- **JavaScript:** `vitest` or `jest` (no mocking libs)
- **Database:** Use test DB with real migrations
- **APIs:** Test against staging/local instances

## Writing Real Tests
```python
# GOOD: Tests actual behavior
def test_user_creation(real_db):
    """Tests that users are actually persisted."""
    user = User.create(email="test@example.com")
    # This catches: ORM issues, DB constraints, connection problems
    assert real_db.query(User).filter_by(email="test@example.com").first()

# BAD: Tests nothing meaningful
# def test_user_creation(mock_db):  # NO!
#     mock_db.return_value = User()  # Tests that Python works?
```

**Ask:** What am I actually testing? Would this catch real bugs?

## Test Data Management
- **Sample data:** Request from user or use production samples
- **Test databases:** Use Docker containers or test instances
- **File fixtures:** Use actual files, not generated ones
- **API testing:** Point to real test endpoints

## CI Integration
- Run tests with real test environment
- Skip tests if environment unavailable
- Document required test infrastructure
- See `ci_cd.md` for pipeline setup

## When Real Testing Seems Impossible
**Think creatively before giving up:**
- Can you use Docker for a test database?
- Can you record real API responses for replay?
- Can you get anonymized production data samples?
- Can you create a minimal test environment?

**If truly impossible:**
1. Document needs in `test_requirements.md`
2. Explain to user what's needed and why
3. Ask for:
   - Sample datasets from production
   - Test environment access
   - Sandbox API credentials
4. **Be honest:** "Without real test data, I cannot verify this works"

## The Testing Mindset
- **You're not checking boxes** - you're building confidence
- **Every test should** catch at least one real bug category
- **Think:** "Will this test save someone from a 3am wake-up call?"

---
*NO MOCKS. Real tests build real confidence. When in doubt, ask for real data.*