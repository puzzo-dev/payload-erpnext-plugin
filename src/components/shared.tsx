'use client'

import React from 'react'
import { Button, FieldLabel, SelectInput, TextInput } from '@payloadcms/ui'

export const fieldWrapperStyle: React.CSSProperties = {
    marginBottom: '1.5rem',
}

export const descriptionStyle: React.CSSProperties = {
    fontSize: '0.8125rem',
    color: 'var(--theme-elevation-500, #6b7280)',
    marginTop: '0.25rem',
    lineHeight: 1.4,
}

export const messageBoxStyle = (variant: 'info' | 'warning' | 'error' | 'success'): React.CSSProperties => ({
    padding: '0.75rem 1rem',
    borderRadius: 'var(--style-radius, 0.25rem)',
    border: '1px solid',
    borderColor:
        variant === 'error'
            ? 'var(--theme-error-250, #fecaca)'
            : variant === 'warning'
                ? 'var(--theme-warning-250, #fde68a)'
                : variant === 'success'
                    ? 'var(--theme-success-250, #bbf7d0)'
                    : 'var(--theme-elevation-150, #e5e7eb)',
    backgroundColor:
        variant === 'error'
            ? 'var(--theme-error-100, #fef2f2)'
            : variant === 'warning'
                ? 'var(--theme-warning-100, #fffbeb)'
                : variant === 'success'
                    ? 'var(--theme-success-100, #f0fdf4)'
                    : 'var(--theme-elevation-50, #f9fafb)',
    color:
        variant === 'error'
            ? 'var(--theme-error-700, #b91c1c)'
            : variant === 'warning'
                ? 'var(--theme-warning-700, #b45309)'
                : variant === 'success'
                    ? 'var(--theme-success-700, #15803d)'
                    : 'var(--theme-elevation-500, #6b7280)',
    fontSize: '0.875rem',
    lineHeight: 1.4,
    marginBottom: '0.75rem',
})

export interface SelectOption {
    label: string
    value: string
}

interface FieldWrapperProps {
    path: string
    label?: string
    description?: string
    children: React.ReactNode
}

export const FieldWrapper: React.FC<FieldWrapperProps> = ({ path, label, description, children }) => (
    <div style={fieldWrapperStyle}>
        {label && <FieldLabel label={label} path={path} />}
        {children}
        {description && <div style={descriptionStyle}>{description}</div>}
    </div>
)

export const LoadingState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>⏳ {message}</div>
)

export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('info')}>{message}</div>
)

export const ErrorState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('error')}>{message}</div>
)

export const SuccessState: React.FC<{ message: string }> = ({ message }) => (
    <div style={messageBoxStyle('success')}>✅ {message}</div>
)

export const ConnectButton: React.FC<{ onClick: () => void; disabled?: boolean; children: React.ReactNode }> = ({ onClick, disabled, children }) => (
    <Button type="button" buttonStyle="primary" size="medium" disabled={disabled} onClick={onClick}>
        {children}
    </Button>
)

interface StyledSelectProps {
    path: string
    value: string
    options: SelectOption[]
    placeholder?: string
    onChange: (value: string) => void
}

export const StyledSelect: React.FC<StyledSelectProps> = ({
    path,
    value,
    options,
    placeholder = 'Select an option',
    onChange,
}) => (
    <SelectInput
        path={path}
        name={path}
        value={value}
        onChange={(option: unknown) => {
            const selected = Array.isArray(option) ? option[0] : option
            onChange(selected?.value != null ? String(selected.value) : '')
        }}
        options={[{ label: `— ${placeholder} —`, value: '' }, ...options]}
    />
)

interface StyledTextInputProps {
    path: string
    value: string
    onChange: (value: string) => void
    placeholder?: string
}

export const StyledTextInput: React.FC<StyledTextInputProps> = ({
    path,
    value,
    onChange,
    placeholder,
}) => (
    <TextInput
        path={path}
        value={value}
        onChange={(e: { target: { value: string } }) => onChange(e.target.value)}
        placeholder={placeholder}
    />
)
