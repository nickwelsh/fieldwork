<?php

declare(strict_types=1);

namespace Formbraid\Laravel\Tests\Fixtures;

use Illuminate\Foundation\Http\FormRequest;

final class ProfileRequest extends FormRequest
{
    public function authorize(): bool
    {
        throw new \LogicException('Generation must not authorize requests.');
    }

    public function rules(): array
    {
        return ['name' => ['required', 'string', 'max:255']];
    }
}
