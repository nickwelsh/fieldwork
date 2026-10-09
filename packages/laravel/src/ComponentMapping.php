<?php

declare(strict_types=1);

namespace Fieldwork\Laravel;

use BackedEnum;
use InvalidArgumentException;

final readonly class ComponentMapping
{
    /** @param array<string, mixed> $props */
    public function __construct(public string $component, public array $props = []) {}

    public static function from(mixed $value): self
    {
        $props = [];
        if (is_array($value)) {
            $props = $value['props'] ?? [];
            $value = $value['component'] ?? null;
        }
        if ($value instanceof BackedEnum) {
            $value = $value->value;
        }
        if (! is_string($value) || $value === '' || ! is_array($props)) {
            throw new InvalidArgumentException('Component mappings require a component name and an array of props.');
        }
        $validatedProps = [];
        foreach ($props as $name => $prop) {
            if (! is_string($name)) {
                throw new InvalidArgumentException('Component prop names must be strings.');
            }
            $validatedProps[$name] = $prop;
        }

        return new self($value, $validatedProps);
    }
}
