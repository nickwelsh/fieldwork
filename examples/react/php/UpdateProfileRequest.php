<?php

declare(strict_types=1);

namespace Example;

use Example\Enums\FormField;
use Example\Enums\FormGroup;
use Fieldwork\Laravel\Field;
use Fieldwork\Laravel\FieldGroup;
use Illuminate\Foundation\Http\FormRequest;

final class UpdateProfileRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => 'required|email',
            'newsletter' => ['required', 'boolean'],
            'company' => ['nullable', 'string', 'required_if:newsletter,true'],
            'address_line_1' => ['required', 'string'],
            'address_line_2' => ['nullable', 'string'],
            'city' => ['required', 'string'],
            'state' => ['required', 'string', 'max:2'],
            'zip' => ['required', 'string', 'min:5', 'max:10'],
        ];
    }

    public function fields(): array
    {
        return ['email' => Field::make()->helpText('We use this to send profile updates.')];
    }

    public function groups(): array
    {
        return ['address' => FieldGroup::make(FormGroup::AddressAutocomplete)->label('Delivery Address')->fields([
            'line1' => 'address_line_1', 'line2' => 'address_line_2', 'city' => 'city', 'state' => 'state', 'postalCode' => 'zip',
        ])];
    }

    public static function fieldConfig(): array
    {
        return ['fields' => ['types' => ['string' => FormField::TextField, 'boolean' => FormField::CheckboxField], 'rules' => [
            'email' => ['component' => FormField::TextField, 'props' => ['type' => 'email']],
        ], 'fallbackType' => 'string']];
    }
}
