import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

describe('JwtAuthGuard', () => {
  function createExecutionContext(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext;
  }

  it('blocks requests without a bearer token', async () => {
    const validateAccessToken = jest.fn();
    const jwtStrategy = {
      validateAccessToken,
    } as unknown as JwtStrategy;

    const guard = new JwtAuthGuard(jwtStrategy);
    const context = createExecutionContext({
      headers: {},
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(validateAccessToken).not.toHaveBeenCalled();
  });
});
